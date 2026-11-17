// Core acceptance tests (spec §12 cases A–K). Every assertion here runs against a
// real SQLite file in a temp directory — no mocks of the storage layer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { CareerDb } from '../host/db.js'
import { Repos } from '../host/repo/index.js'
import {
  analyzeMatch,
  applyHardFilters,
  computeDedupeKey,
  extractSkills,
  normalizeJob,
  parseDaysPerWeek,
  parseDeadline,
  parseGradeLimit,
} from '../host/domain.js'
import { titleKey } from '../host/util.js'
import { parseResume, splitSections } from '../host/resume.js'
import { CONNECTOR_META, inferStatusFromText, parseCareersPage, parsePastedJob, suggestSocialQueries } from '../host/sources.js'
import { makeEnv, sampleProfile, silentLogger } from './helpers.mjs'

// ─────────────────────────────────────────────────────────── case J: persistence
describe('database + migrations', () => {
  it('applies every migration and reports a schema version', () => {
    const env = makeEnv()
    try {
      const info = env.db.info()
      assert.ok(info.schemaVersion >= 4, `schema version should be >= 4, got ${info.schemaVersion}`)
      assert.ok(['trigram', 'unicode61'].includes(info.ftsMode), `fts mode: ${info.ftsMode}`)
      const rows = env.db.all('SELECT name FROM sqlite_master WHERE type = ?', ['table'])
      const names = rows.map((r) => r.name)
      for (const required of ['user_profile', 'resume_version', 'skill', 'industry', 'company', 'job', 'job_source',
        'job_status_history', 'forum_post', 'forum_claim', 'interview_experience', 'hiring_requirement',
        'application', 'application_event', 'monitoring_rule', 'notification', 'research_report', 'evidence',
        'sync_run', 'source_health']) {
        assert.ok(names.includes(required), `missing table ${required}`)
      }
    } finally {
      env.cleanup()
    }
  })

  it('re-opening the same file keeps data and does not re-run migrations', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'careeros-reopen-'))
    const logger = silentLogger()
    const file = path.join(dir, 'career.db')
    const first = new CareerDb(file, logger).open()
    first.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', ['k', 'v', new Date().toISOString()])
    const version = first.version
    first.close()

    const second = new CareerDb(file, logger).open()
    try {
      assert.equal(second.version, version)
      assert.equal(second.get('SELECT value FROM settings WHERE key = ?', ['k']).value, 'v')
      const applied = second.all('SELECT version FROM schema_migrations')
      assert.equal(applied.length, version, 'each migration recorded exactly once')
    } finally {
      second.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes a working transaction that rolls back on error', () => {
    const env = makeEnv()
    try {
      assert.throws(() => env.db.tx(() => {
        env.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', ['x', 'y', new Date().toISOString()])
        throw new Error('boom')
      }), /boom/)
      assert.equal(env.db.get('SELECT key FROM settings WHERE key = ?', ['x']), undefined)
    } finally {
      env.cleanup()
    }
  })
})

// ────────────────────────────────────────────── case A: resume import + correction
describe('resume parsing', () => {
  const text = `张三
计算机科学与技术 · 本科 · 2027 届
zhangsan@example.com   13800001111

教育背景
示例大学 计算机科学与技术 2023.09-2027.06

实习经历
某某科技有限公司 产品经理实习生 2025.07-2025.09
- 负责用户调研，产出 2 份需求文档
- 使用 SQL 与 Python 完成数据分析，推动 A/B测试

项目经历
校园二手平台 负责人 2025.03-2025.06
- 独立完成 React 前端与 Node.js 后端

技能
Python、SQL、Axure、Figma、英语 CET-6`

  it('splits sections and extracts education without inventing anything', () => {
    const sections = splitSections(text)
    assert.ok(sections.education.length > 0)
    assert.ok(sections.experience.length > 0)
    const proposal = parseResume(text)
    assert.equal(proposal.requiresConfirmation, true, 'extraction is never auto-committed')
    assert.equal(proposal.education[0].school, '示例大学')
    assert.match(proposal.education[0].degree, /本科/)
    assert.equal(proposal.education[0].gradYear, 2027)
    assert.ok(proposal.skills.includes('Python'))
    assert.ok(proposal.skills.includes('SQL'))
    assert.equal(proposal.contact.phoneMasked, '138****1111')
    assert.ok(proposal.experience.length >= 1)
    assert.ok(proposal.caveat.includes('不得视为事实'))
  })

  it('returns nulls instead of guessing when a resume is nearly empty', () => {
    const proposal = parseResume('hello')
    assert.equal(proposal.identity.displayName, null)
    assert.equal(proposal.education.length, 0)
    assert.ok(proposal.notes.length > 0)
  })
})

// ───────────────────────────────────────────────────── case C: dedupe / entity merge
describe('job entity resolution', () => {
  it('collapses the same posting from two sources into one row', () => {
    const env = makeEnv()
    try {
      const first = env.repos.jobs.upsertJob({
        company: '字节跳动', title: '产品经理实习生', location: '北京',
        url: 'https://jobs.example.com/a/1',
        source: { sourceType: 'official_careers', url: 'https://jobs.example.com/a/1', sourceName: '官网' },
      })
      const second = env.repos.jobs.upsertJob({
        company: '字节跳动有限公司', title: '2026暑期实习-产品经理', location: '北京',
        url: 'https://board.example.com/job/999',
        source: { sourceType: 'job_board', url: 'https://board.example.com/job/999', sourceName: '第三方' },
      })
      assert.equal(first.created, true)
      assert.equal(second.created, false, 'second sighting must merge, not duplicate')
      assert.equal(second.id, first.id)
      const total = Number(env.db.scalar('SELECT count(*) FROM job'))
      assert.equal(total, 1)
      const sources = env.db.all('SELECT source_url FROM job_source WHERE job_id = ?', [first.id])
      assert.equal(sources.length, 2, 'both provenances are kept')
    } finally {
      env.cleanup()
    }
  })

  it('keeps genuinely different postings apart', () => {
    const env = makeEnv()
    try {
      const a = env.repos.jobs.upsertJob({ company: '甲公司', title: '数据分析实习生', location: '北京' })
      const b = env.repos.jobs.upsertJob({ company: '甲公司', title: '前端开发实习生', location: '北京' })
      const c = env.repos.jobs.upsertJob({ company: '甲公司', title: '数据分析实习生', location: '上海' })
      assert.equal(new Set([a.id, b.id, c.id]).size, 3)
    } finally {
      env.cleanup()
    }
  })

  it('uses an official job code as the strongest identity signal', () => {
    const env = makeEnv()
    try {
      const a = env.repos.jobs.upsertJob({ company: '乙公司', title: '算法实习生', jobCode: 'JR-1001', location: '上海' })
      const b = env.repos.jobs.upsertJob({ company: '乙公司', title: '算法工程师（实习）', jobCode: 'JR-1001', location: '上海' })
      assert.equal(a.id, b.id)
      assert.equal(b.reason, 'job_code')
    } finally {
      env.cleanup()
    }
  })

  it('treats city-prefixed legal names as the same employer', () => {
    const env = makeEnv()
    try {
      const a = env.repos.jobs.upsertJob({
        company: '字节跳动', title: '数据分析实习生', location: '北京',
        url: 'https://jobs.example.com/bytedance/1001',
        source: { sourceType: 'official_careers', url: 'https://jobs.example.com/bytedance/1001' },
      })
      const b = env.repos.jobs.upsertJob({
        company: '北京字节跳动科技有限公司', title: '2026暑期实习-数据分析', location: '北京',
        url: 'https://board.example.com/job/999',
        source: { sourceType: 'job_board', url: 'https://board.example.com/job/999' },
      })
      assert.equal(b.created, false, 'legal-name variant must merge, not duplicate')
      assert.equal(a.id, b.id)
      assert.equal(Number(env.db.scalar('SELECT count(*) FROM job')), 1)
      const company = env.db.get('SELECT * FROM company')
      assert.ok(company.aliases.includes('北京字节跳动科技有限公司'), 'the variant is kept as a visible alias')
    } finally {
      env.cleanup()
    }
  })

  it('keeps related but genuinely different brands apart', () => {
    const env = makeEnv()
    try {
      const a = env.repos.jobs.upsertJob({ company: '腾讯', title: '后端开发实习生', location: '深圳' })
      const b = env.repos.jobs.upsertJob({ company: '腾讯音乐', title: '后端开发实习生', location: '深圳' })
      assert.notEqual(a.id, b.id, 'a brand token must not be stripped as corporate noise')
    } finally {
      env.cleanup()
    }
  })

  it('normalizes titles and dedupe keys deterministically', () => {    assert.equal(titleKey('2026暑期实习-产品经理'), titleKey('产品经理（暑期实习）'))
    const job = normalizeJob({ company: '丙公司', title: '运营实习生', location: '杭州' })
    assert.equal(computeDedupeKey(job), computeDedupeKey(normalizeJob({ company: '丙公司', title: '运营实习生', location: '杭州' })))
  })
})

// ───────────────────────────────────────────── case D: status history, no silent truth
describe('job status verification', () => {
  it('records official status changes in history instead of overwriting', () => {
    const env = makeEnv()
    try {
      const { id } = env.repos.jobs.upsertJob(
        { company: '丁公司', title: '战略实习生', status: 'OPEN', url: 'https://c.example.com/1' },
        { official: true, source: { sourceType: 'official_careers', url: 'https://c.example.com/1' } },
      )
      let job = env.repos.jobs.getJob(id)
      assert.equal(job.status, 'OPEN')
      assert.ok(job.status_verified_at, 'official evidence stamps a verification time')

      env.repos.jobs.applyStatusObservation(id, {
        status: 'CLOSED', official: true, sourceType: 'official_careers',
        sourceUrl: 'https://c.example.com/1', evidence: '该职位已下线',
      })
      job = env.repos.jobs.getJob(id)
      assert.equal(job.status, 'CLOSED')
      const history = job.history.map((h) => h.status)
      assert.ok(history.includes('CLOSED'), 'history keeps the new state')
      // one entry for the initial UNKNOWN→OPEN confirmation, one for OPEN→CLOSED
      assert.equal(history.length, 2)

      env.repos.jobs.applyStatusObservation(id, { status: 'OPEN', official: true, sourceType: 'official_careers' })
      assert.equal(env.repos.jobs.getJob(id).history.length, 3, 'every transition is appended')
    } finally {
      env.cleanup()
    }
  })

  it('never lets a third-party sighting assert "still open"', () => {
    const env = makeEnv()
    try {
      const { id } = env.repos.jobs.upsertJob({
        company: '戊公司', title: '研发实习生', status: 'OPEN',
        url: 'https://board.example.com/x', source: { sourceType: 'job_board', url: 'https://board.example.com/x' },
      }, { official: false })
      const job = env.repos.jobs.getJob(id)
      assert.equal(job.status, 'UNVERIFIED')
      assert.equal(job.status_verified_at, null, 'third-party text must not stamp verification')
    } finally {
      env.cleanup()
    }
  })

  it('marks long-unverified openings STALE rather than leaving them OPEN', () => {
    const env = makeEnv()
    try {
      const { id } = env.repos.jobs.upsertJob(
        { company: '己公司', title: '投资实习生', status: 'OPEN', url: 'https://f.example.com/1' },
        { official: true, source: { sourceType: 'official_careers', url: 'https://f.example.com/1' } },
      )
      // A freshly verified job must survive the policy check.
      assert.equal(env.repos.jobs.expireStale(21), 0)
      assert.equal(env.repos.jobs.getJob(id).status, 'OPEN')

      // Backdate the verification past the policy window deterministically instead of
      // relying on today's clock (which made this assertion time-of-day dependent).
      env.db.run('UPDATE job SET status_verified_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', id])
      assert.equal(env.repos.jobs.expireStale(21), 1)
      assert.equal(env.repos.jobs.getJob(id).status, 'STALE')
      assert.ok(env.repos.jobs.getJob(id).history.some((h) => h.status === 'STALE'), 'downgrade is recorded in history')
    } finally {
      env.cleanup()
    }
  })
})

// ───────────────────────────────────────────────────── case G: explainable matching
describe('match engine', () => {
  it('scores, explains, and blocks on hard constraints without inventing facts', () => {
    const env = makeEnv()
    try {
      const profile = env.repos.profile.update(sampleProfile())
      const { id } = env.repos.jobs.upsertJob({
        company: '字节跳动', title: '数据分析实习生', location: '北京',
        internshipType: 'daily', daysPerWeek: 4,
        description: '使用 SQL 与 Python 完成产品数据分析，参与 A/B测试',
        requirements: '熟悉 SQL、Python，每周 4 天，实习 6 个月',
        url: 'https://jobs.bytedance.com/1',
      })
      const job = env.repos.jobs.getJob(id)
      const analysis = analyzeMatch(profile, job)
      assert.ok(analysis.score > 0 && analysis.score <= 100)
      assert.ok(Object.keys(analysis.breakdown).length === 6, 'six explainable dimensions')
      assert.ok(analysis.reasons.matched.some((m) => m.includes('SQL')), 'matched skills are listed')
      assert.equal(typeof analysis.bandLabel, 'string')
      assert.equal(Object.values(analysis.breakdown).reduce((a, b) => a + b, 0) <= 100, true)

      const blocked = analyzeMatch(profile, { ...job, title: '销售实习生', description: '销售岗位' })
      assert.equal(blocked.band, 'hard_mismatch')
      assert.ok(blocked.hardBlocks.some((b) => b.includes('销售')))
    } finally {
      env.cleanup()
    }
  })

  it('applies hard filters for weekly days and cities', () => {
    const profile = { ...sampleProfile(), weekly_days: 3, cities: ['北京'], excluded: [] }
    const reasons = applyHardFilters(profile, { title: '实习', location: '上海', daysPerWeek: 5 })
    assert.ok(reasons.some((r) => r.includes('每周')))
    assert.ok(reasons.some((r) => r.includes('地点')))
  })

  it('ranks every job and persists the score', () => {
    const env = makeEnv()
    try {
      env.repos.profile.update(sampleProfile())
      for (const title of ['数据分析实习生', '市场运营实习生', '产品经理实习生']) {
        env.repos.jobs.upsertJob({ company: '庚公司', title, location: '北京', description: 'SQL Python 数据分析' })
      }
      const profile = env.repos.profile.getWithResume()
      profile.__hash = env.repos.profile.hash()
      const ranked = env.repos.jobs.rankAll(profile)
      assert.equal(ranked.length, 3)
      assert.ok(ranked[0].analysis.score >= ranked[2].analysis.score)
      const stored = env.db.all('SELECT match_score FROM job WHERE match_score IS NOT NULL')
      assert.equal(stored.length, 3)
    } finally {
      env.cleanup()
    }
  })
})

// ─────────────────────────────────────── case F: hiring bar keeps classes separate
describe('hiring bar and forum intelligence', () => {
  it('separates official requirements from hearsay', () => {
    const env = makeEnv()
    try {
      const company = env.repos.jobs.resolveCompany('辛科技')
      env.repos.intel.addRequirement({ companyId: company.id, kind: 'hard', text: '必须 2027 届本科及以上', evidenceLevel: 'A', sourceType: 'official_careers' })
      env.repos.intel.addRequirement({ companyId: company.id, kind: 'preferred', text: '有数据分析实习加分', evidenceLevel: 'A' })
      env.repos.intel.addRequirement({ companyId: company.id, kind: 'observed', text: '面经里常问 SQL 窗口函数', evidenceLevel: 'C' })
      env.repos.intel.addRequirement({ companyId: company.id, kind: 'unverified', text: '据说只看 985', evidenceLevel: 'D' })
      const bar = env.repos.intel.barFor({ companyId: company.id })
      assert.equal(bar.hard.length, 1)
      assert.equal(bar.preferred.length, 1)
      assert.equal(bar.observed.length, 1)
      assert.equal(bar.unverified.length, 1)
      assert.match(bar.disclaimer, /不建议|不能推断|门槛/)
    } finally {
      env.cleanup()
    }
  })

  it('dedupes reposted forum content and keeps evidence level C', () => {
    const env = makeEnv()
    try {
      const payload = {
        platform: 'xiaohongshu', content: '面经：三轮面试，先问项目再问 SQL 优化',
        url: 'https://xhs.example.com/1', company: '辛科技', title: '实习面经',
        claims: [{ category: 'interview', claim: '先项目后八股', evidenceLevel: 'C' }],
      }
      const first = env.repos.intel.addForumPost(payload)
      const second = env.repos.intel.addForumPost(payload)
      assert.equal(first.duplicate, false)
      assert.equal(second.duplicate, true, 'identical content is not a second data point')
      const claims = env.repos.intel.claimsFor({ companyId: first.company_id })
      assert.equal(claims.total, 0, 'claims are only added on first import')
      env.repos.intel.addClaim({ postId: first.id, category: 'interview', claim: '先项目后八股', evidenceLevel: 'C', firstHand: true })
      const after = env.repos.intel.claimsFor({ companyId: first.company_id })
      assert.equal(after.total, 1)
      assert.match(after.caveat, /偏差|自述/)
    } finally {
      env.cleanup()
    }
  })
})

// ────────────────────────────────────────── case H: application status persistence
describe('application CRM', () => {
  it('persists status transitions as an append-only timeline', () => {
    const env = makeEnv()
    try {
      const { id: jobId } = env.repos.jobs.upsertJob({ company: '壬公司', title: '数据实习生', url: 'https://g.example.com/1' })
      const app = env.repos.applications.create({ jobId, status: 'ready', channel: '官网' })
      assert.equal(app.status, 'ready')
      const updated = env.repos.applications.update(app.id, { status: 'applied', note: '10:30 提交' })
      assert.equal(updated.status, 'applied')
      assert.ok(updated.applied_at, 'applied date is stamped automatically')
      const events = updated.events
      assert.equal(events.filter((e) => e.type === 'status').length, 2)
      assert.equal(events.filter((e) => e.type === 'submission_frozen').length, 1)
      assert.ok(events.some((e) => e.from_status === 'ready' && e.to_status === 'applied'))
      const reloaded = env.repos.applications.get(app.id)
      assert.equal(reloaded.status, 'applied', 'survives a fresh read from SQLite')
      const board = env.repos.applications.board()
      assert.ok(board.columns.find((c) => c.status === 'applied').items.length === 1)
    } finally {
      env.cleanup()
    }
  })

  it('rejects unknown statuses instead of silently accepting them', () => {
    const env = makeEnv()
    try {
      const app = env.repos.applications.create({ companyName: '癸公司', jobTitle: '实习' })
      const updated = env.repos.applications.update(app.id, { status: 'nonsense' })
      assert.equal(updated.status, 'saved', 'unknown status is ignored')
    } finally {
      env.cleanup()
    }
  })
})

// ──────────────────────────────── case I + K: monitor failures and blocked sources
describe('monitoring and source health', () => {
  it('logs a failed run with its error and last success time', async () => {
    const env = makeEnv()
    try {
      const { Monitor } = await import('../host/monitor.js')
      const monitor = new Monitor({ repos: env.repos, config: { httpTimeoutMs: 500, httpGapMs: 0 }, logger: env.logger, search: null })
      const rule = env.repos.monitor.createRule({ name: '坏链接', kind: 'careers_page', spec: { url: 'https://127.0.0.1:9/never' } })
      const result = await monitor.runRule(rule.id)
      assert.equal(result.status, 'error')
      assert.ok(result.error)
      const stored = env.repos.monitor.getRule(rule.id)
      assert.equal(stored.last_status, 'error')
      assert.ok(stored.last_error)
      const runs = env.repos.monitor.listRuns()
      assert.equal(runs[0].status, 'error')
      assert.ok(runs[0].finished_at)
    } finally {
      env.cleanup()
    }
  })

  it('reconciles sync runs interrupted by a crash', () => {
    const env = makeEnv()
    try {
      env.repos.monitor.startRun('careers_page', 'x')
      assert.equal(env.db.get('SELECT status FROM sync_run').status, 'running')
      const closed = env.repos.monitor.reconcileRuns()
      assert.equal(closed, 1)
      assert.equal(env.db.get('SELECT status FROM sync_run').status, 'error')
    } finally {
      env.cleanup()
    }
  })

  it('declares login-required sources as browser_session, never auto-collected', () => {
    const env = makeEnv()
    try {
      const gated = CONNECTOR_META.filter((c) => c.accessMode === 'browser_session')
      assert.ok(gated.length >= 2, 'job boards / social platforms require the user session')
      for (const entry of gated) {
        assert.equal(entry.needsUser, true)
        assert.ok(entry.rateLimitNote.length > 10)
      }
      // 不得把需要登录的平台伪装成 public_page 自动可用
      assert.ok(!CONNECTOR_META.some((c) => ['job_board', 'social_platform'].includes(c.connector) && c.accessMode === 'public_page'))
      const suggestion = suggestSocialQueries({ company: '字节跳动', role: '产品经理' })
      assert.ok(suggestion.links.length > 0)
    } finally {
      env.cleanup()
    }
  })
})

// ───────────────────────────────────────────────────── parsing helpers (unit-level)
describe('JD parsing', () => {
  it('extracts deadline, days per week, grade limit and city from pasted text', () => {
    assert.equal(parseDeadline('投递截止 2027-03-15'), '2027-03-15')
    assert.equal(parseDaysPerWeek('每周 4 天到岗'), 4)
    assert.equal(parseDaysPerWeek('每周出勤 5 天'), 5)
    assert.equal(parseDaysPerWeek('每周至少 3 天'), 3)
    assert.equal(parseDaysPerWeek('一周 4 天'), 4)
    assert.equal(parseGradeLimit('面向 2027 届毕业生'), '2027届')
    const job = parsePastedJob(
      `字节跳动 数据分析实习生
工作地点：北京
每周 4 天，实习 6 个月
要求：熟悉 SQL、Python
投递截止 2027-01-20
https://jobs.bytedance.com/position/123`,
      {},
    )
    assert.equal(job.companyName, '字节跳动')
    assert.equal(job.location, '北京')
    assert.equal(job.daysPerWeek, 4)
    assert.equal(job.deadline, '2027-01-20')
    assert.ok(job.skills.includes('SQL'))
    assert.match(job.url, /bytedance/)
  })

  it('refuses text with no company instead of inventing one', () => {
    assert.throws(() => parsePastedJob('我们招实习生，欢迎投递'), /未识别到公司名/)
  })

  it('does not let single-letter skills match inside other words', () => {
    const skills = extractSkills('熟悉 React 与 PyTorch，做过产品设计；具备 C++ 经验')
    assert.ok(skills.includes('React'))
    assert.ok(skills.includes('PyTorch'))
    assert.ok(skills.includes('C++'))
    assert.ok(!skills.includes('C'), 'React/PyTorch must not satisfy a C requirement')
    assert.ok(!extractSkills('使用 Figma 做原型').includes('R'))
    assert.ok(extractSkills('熟悉 R 语言做统计').includes('R'))
  })

  it('reads hiring signals and job links out of a careers page', () => {
    const html = `<html><body>
      <h1>校园招聘</h1><p>正在招聘 2027 届实习生</p>
      <a href="/position/1001">数据分析实习生</a>
      <a href="/position/1002">产品经理实习生</a>
      <a href="/about">关于我们</a>
    </body></html>`
    const page = parseCareersPage(html, 'https://jobs.example.com/campus')
    assert.equal(page.links.length, 2)
    assert.equal(page.signals.open, true)
    assert.equal(inferStatusFromText('该职位已下线'), 'CLOSED')
    assert.equal(inferStatusFromText('即将开启 2027 暑期实习'), 'UPCOMING')
    assert.equal(inferStatusFromText('欢迎投递'), null)
  })
})
