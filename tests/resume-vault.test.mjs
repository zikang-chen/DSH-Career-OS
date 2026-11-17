// 简历知识库（素材库）、针对岗位微调、LaTeX 生成与编译。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { compileTex, detectEngines, escapeTex, renderResumeTex, renderResumeText } from '../host/latex.js'
import { KIND_LABEL, planTailor, sectionsFromSelection } from '../host/tailor.js'
import { makeEnv } from './helpers.mjs'

const job = {
  id: 'job-1',
  company_name: '示例科技',
  title: '数据分析实习生',
  location: '北京',
  skills: ['SQL', 'Python', '数据分析', 'A/B测试'],
  description: '使用 SQL 与 Python 完成用户行为数据分析，参与 A/B测试 设计。',
  requirements: '熟悉 SQL、Python，每周 4 天。',
}

const experiences = [
  { id: 'e1', kind: 'education', organization: '示例大学', role: '本科', start_at: '2023-09', end_at: '2027-06', bullets: ['计算机科学与技术'], skills: [], tags: [] },
  { id: 'e2', kind: 'internship', organization: '某科技', role: '数据分析实习生', start_at: '2025-07', end_at: '2025-09', bullets: ['用 SQL 完成留存分析，定位 3 个流失点', '用 Python 做用户分群，覆盖 12 万用户', '整理周报'], skills: ['SQL', 'Python'], tags: [] },
  { id: 'e3', kind: 'project', organization: '校园二手平台', role: '负责人', start_at: '2025-03', end_at: '2025-06', bullets: ['独立完成 React 前端', '做需求分析'], skills: ['React'], tags: [] },
  { id: 'e4', kind: 'activity', organization: '学生会', role: '干事', start_at: '2024-09', end_at: '2025-01', bullets: ['组织 3 场活动'], skills: [], tags: [] },
]

describe('experience vault', () => {
  it('stores rich experiences and keeps them unverified until confirmed', () => {
    const env = makeEnv()
    try {
      const created = env.repos.profile.addExperience({
        kind: 'internship',
        organization: '某科技',
        role: '数据分析实习生',
        startAt: '2025-07',
        endAt: '2025-09',
        bullets: ['用 SQL 完成留存分析', '用 Python 做用户分群'],
        skills: ['SQL', 'Python'],
      })
      assert.equal(created.kind, 'internship')
      assert.equal(created.verified, false, 'new material must not be treated as confirmed')
      assert.equal(created.bullets.length, 2)
      assert.equal(created.period, '2025-07 – 2025-09')

      const updated = env.repos.profile.updateExperience(created.id, { verified: true, bullets: ['只保留一条'] })
      assert.equal(updated.verified, true)
      assert.deepEqual(updated.bullets, ['只保留一条'])
      assert.equal(env.repos.profile.listExperiences().length, 1)
      assert.equal(env.repos.profile.listExperiences({ kind: 'project' }).length, 0)
      assert.equal(env.repos.profile.deleteExperience(created.id), true)
      assert.equal(env.repos.profile.listExperiences().length, 0)
    } finally {
      env.cleanup()
    }
  })

  it('seeds the vault from a parsed resume without marking anything verified', () => {
    const env = makeEnv()
    try {
      const proposal = {
        education: [{ school: '示例大学', degree: '本科', major: '计算机', gradYear: 2027 }],
        experience: [{ organization: '某科技', role: '数据分析实习生', start: '2025-07', end: '2025-09', bullets: ['用 SQL 做分析'] }],
        projects: [{ name: '校园二手平台', bullets: ['React 前端'] }],
        research: [],
        certificates: ['CET-6'],
      }
      const created = env.repos.profile.importExperiencesFromResume(proposal, 'resume-1')
      assert.equal(created.length, 4)
      const kinds = created.map((c) => c.kind)
      assert.deepEqual(kinds, ['education', 'internship', 'project', 'award'])
      assert.ok(created.every((c) => c.verified === false))
      assert.equal(created[0].sort_order, -10, 'education sorts first')
    } finally {
      env.cleanup()
    }
  })
})

describe('tailoring to a target job', () => {
  it('keeps the relevant experience, trims weak bullets, and reports real gaps', () => {
    const plan = planTailor({ experiences, job, maxEntries: 4, bulletsPerEntry: 2 })
    const selectedIds = plan.selected.map((s) => s.experienceId)
    assert.ok(selectedIds.includes('e1'), 'education is always kept')
    assert.ok(selectedIds.includes('e2'), 'the SQL/Python internship must be kept')
    const e2 = plan.selected.find((s) => s.experienceId === 'e2')
    assert.equal(e2.bullets.length, 2, 'bullets trimmed to the limit')
    assert.ok(e2.bullets[0].includes('SQL'), 'most relevant bullet comes first')
    assert.ok(e2.matchedSkills.includes('SQL'), 'matched skills keep their readable spelling')
    assert.ok(plan.gaps.includes('A/B测试'), `gaps must be human-readable, got ${JSON.stringify(plan.gaps)}`)
    assert.ok(plan.rationale.some((r) => r.includes('缺口')))
    assert.ok(!JSON.stringify(plan).includes('编造'), 'must never claim to invent content')
  })

  it('never fabricates experience when the vault is empty', () => {
    const plan = planTailor({ experiences: [], job })
    assert.equal(plan.selected.length, 0)
    assert.ok(plan.warnings.some((w) => w.includes('素材库')))
    assert.equal(plan.gaps.length, 4)
    assert.ok(plan.gaps.includes('SQL'))
    assert.ok(plan.gaps.includes('A/B测试'))
  })

  it('orders sections the way a CV should read', () => {
    const plan = planTailor({ experiences, job })
    const sections = sectionsFromSelection(plan.selected)
    const labels = sections.map((s) => s.label)
    assert.equal(labels[0], KIND_LABEL.education)
    const order = labels.map((l) => ['教育背景', '实习经历', '项目经历', '科研经历', '校园经历', '奖项荣誉', '证书与技能', '技能'].indexOf(l))
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'sections must follow KIND_ORDER')
  })

  it('creates a version with lineage instead of overwriting the previous one', () => {
    const env = makeEnv()
    try {
      for (const exp of experiences) env.repos.profile.addExperience(exp)
      const base = env.repos.profile.addResume({ label: '原始版', rawText: '旧内容', sourceType: 'upload' })
      const plan = planTailor({ experiences: env.repos.profile.listExperiences(), job })
      const sections = sectionsFromSelection(plan.selected)
      const profile = env.repos.profile.get()
      const version = env.repos.profile.createVersionFromSections({
        label: '示例科技·数据分析 定制版',
        sections,
        profile,
        rawText: renderResumeText({ profile, sections }),
        texSource: renderResumeTex({ profile, sections }),
        parentVersionId: base.id,
        targetJobId: 'job-1',
        sourceType: 'tailored',
        setActive: false,
      })
      assert.notEqual(version.id, base.id)
      assert.equal(version.parent_version_id, base.id)
      assert.equal(version.target_job_id, 'job-1')
      assert.ok(version.tex_source.includes('\\documentclass'))
      const lineage = env.repos.profile.resumeLineage(version.id)
      assert.equal(lineage.length, 2)
      assert.equal(lineage[1].label, '原始版')
      assert.equal(env.repos.profile.getResume(base.id).raw_text, '旧内容', 'the source version is untouched')
    } finally {
      env.cleanup()
    }
  })
})

describe('latex rendering', () => {
  it('escapes characters that would break the document', () => {
    assert.equal(escapeTex('a_b & c%d'), 'a\\_b \\& c\\%d')
    assert.ok(escapeTex('\\cmd').includes('textbackslash'))
  })

  it('renders a complete document with Chinese content', () => {
    const sections = sectionsFromSelection(planTailor({ experiences, job }).selected)
    const tex = renderResumeTex({ profile: { display_name: '演示用户', headline: '找数据分析实习' }, sections })
    assert.ok(tex.startsWith('\\documentclass'))
    assert.ok(tex.includes('\\begin{document}'))
    assert.ok(tex.trimEnd().endsWith('\\end{document}'))
    assert.ok(tex.includes('教育背景'))
    assert.ok(tex.includes('用 SQL 完成留存分析'))
    assert.ok(tex.includes('ctexart'), 'must use a Chinese-capable class')
  })

  it('renders a plain-text projection for matching and diffing', () => {
    const sections = sectionsFromSelection(planTailor({ experiences, job }).selected)
    const text = renderResumeText({ profile: { display_name: '演示用户' }, sections })
    assert.ok(text.includes('教育背景'))
    assert.ok(text.includes('- 用 SQL 完成留存分析'))
  })
})

describe('local latex compilation', () => {
  it('compiles a minimal Chinese document to PDF when an engine exists', async () => {
    const engines = detectEngines()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careeros-tex-'))
    try {
      if (!engines.length) {
        console.log('SKIP: no LaTeX engine on this machine')
        return
      }
      const tex = renderResumeTex({
        profile: { display_name: '测试用户' },
        sections: [{ label: '教育背景', items: [{ org: '示例大学', role: '本科', period: '2023-2027', bullets: ['计算机科学与技术'] }] }],
      })
      const result = await compileTex(tex, { dataDir: dir, timeoutMs: 90_000, preferEngine: engines[0].engine })
      assert.equal(result.ok, true, `compile failed: ${result.error ?? ''}\n${result.log ?? ''}`)
      assert.ok(fs.existsSync(result.pdfPath))
      assert.ok(fs.statSync(result.pdfPath).size > 1000, 'PDF should have real content')
      const again = await compileTex(tex, { dataDir: dir, timeoutMs: 90_000, preferEngine: engines[0].engine })
      assert.equal(again.cached, true, 'identical source must reuse the compiled PDF')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a failure instead of throwing when the source is broken', async () => {
    const engines = detectEngines()
    if (!engines.length) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careeros-tex-bad-'))
    try {
      const result = await compileTex('\\documentclass{article}\\begin{document}未闭合', { dataDir: dir, timeoutMs: 60_000, preferEngine: engines[0].engine })
      assert.equal(result.ok, false)
      assert.ok(typeof result.error === 'string' && result.error.length > 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
