import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildJobQuery } from '../host/repo/jobs.js'
import { makeEnv } from './helpers.mjs'

// Only throw-away makeEnv databases; never opens the user's personal database.
function fixture(run) {
  const env = makeEnv()
  let sequence = 0
  const insert = (patch = {}) => {
    const n = ++sequence
    const row = {
      id: `job-${String(n).padStart(4, '0')}`, dedupe_key: `query-v2-${n}`,
      company_name: '示例公司', title: 'AI 产品实习', title_key: 'ai产品实习', location: '北京',
      remote_type: 'onsite', internship_type: 'daily', recruit_type: 'summer',
      description: '需求调研', requirements: 'SQL 数据分析', skills: '["SQL"]',
      status: 'OPEN', archived: 0, grade_limit: null, days_per_week: 3,
      match_score: 80, created_at: '2026-10-01', updated_at: '2026-11-01',
      ...patch,
    }
    const columns = Object.keys(row)
    env.db.run(`INSERT INTO job (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row))
    return row.id
  }
  try { run(env.repos.jobs, insert, env) } finally { env.cleanup() }
}

function ids(rows) { return rows.map((row) => row.id) }

describe('v2 SQL job query foundation', () => {
  it('filters the entire matching set past 400/500, with exact count and city combination', () => fixture((repo, insert) => {
    for (let i = 0; i < 620; i += 1) insert({ location: i < 520 ? '北京' : '上海', recruit_type: i < 580 ? 'summer' : 'daily' })
    const page = repo.queryPage({ query: 'AI SQL', location: '上海', recruitType: 'daily', limit: 500 })
    assert.equal(page.total, 40)
    assert.equal(page.items.length, 40)
    assert.equal(page.items[0].id, 'job-0581')
    assert.equal(repo.countJobs({ query: 'AI SQL', limit: 1, offset: 600 }), 620)
    assert.equal(repo.listJobs({ query: 'AI SQL', limit: 9999 }).length, 500)
    assert.equal(repo.searchJobIds('AI SQL', 500).length, 500)
  }))

  it('ANDs whitespace tokens across all five fields without a prefetched ID query', () => fixture((repo, insert) => {
    const hit = insert({ title: '产品', company_name: 'Alpha', description: '需求', requirements: 'SQL', location: '上海' })
    insert({ title: '产品', company_name: 'Alpha', requirements: 'Python', location: '上海' })
    repo.searchJobIds = () => { throw new Error('must not prefetch IDs') }
    assert.deepEqual(ids(repo.listJobs({ query: ' 产品\tAlpha\n需求 SQL 上海 ' })), [hit])
    assert.equal(repo.countJobs({ query: ' 产品 Alpha 需求 SQL 上海 ' }), 1)
    assert.equal(repo.countJobs({ query: "' OR 1=1 --" }), 0)
    assert.ok(buildJobQuery({ query: 'SQL' }).params.includes('%SQL%'))
  }))

  it('keeps stable id ordering across offsets and clamps integer pagination', () => fixture((repo, insert) => {
    for (let i = 0; i < 8; i += 1) insert()
    const whole = repo.listJobs({ limit: 20 })
    const page1 = repo.queryPage({ limit: 3, offset: 0 })
    const page2 = repo.queryPage({ limit: 3, offset: 3 })
    assert.deepEqual(ids([...page1.items, ...page2.items]), ids(whole.slice(0, 6)))
    assert.deepEqual(ids(repo.listJobs({ limit: 20 })), ids(whole))
    assert.equal(page2.total, 8)
    assert.equal(repo.queryPage({ limit: 0, offset: -5 }).limit, 1)
    assert.equal(repo.queryPage({ limit: 2.9, offset: 1.9 }).offset, 1)
    assert.equal(repo.queryPage({ limit: 'bad', offset: 'bad' }).limit, 100)
    assert.equal(repo.queryPage({ offset: 99 }).items.length, 0)
  }))

  it('supports city arrays/comma lists without implicitly including remote jobs', () => fixture((repo, insert) => {
    const beijing = insert()
    const shanghai = insert({ location: '上海、杭州', remote_type: 'hybrid' })
    const remote = insert({ location: '远程', remote_type: 'remote' })
    insert({ location: '深圳' })
    assert.deepEqual(ids(repo.listJobs({ location: ['北京', '上海'] })), [beijing, shanghai])
    assert.deepEqual(ids(repo.listJobs({ location: '北京,上海' })), [beijing, shanghai])
    assert.deepEqual(ids(repo.listJobs({ remoteType: 'remote' })), [remote])
    assert.deepEqual(ids(repo.listJobs({ location: '北京', remoteType: 'remote' })), [])
    assert.equal(repo.countJobs({ remoteType: ['onsite', 'hybrid'] }), 3)
  }))

  it('requires both trimmed JD fields and classifies unknown or whitespace as incomplete', () => fixture((repo, insert) => {
    const complete = insert()
    for (const patch of [{ description: null }, { requirements: null }, { description: '  ' }, { requirements: '\t\n\r　' }, { description: '', requirements: '' }]) insert(patch)
    assert.deepEqual(ids(repo.listJobs({ jdComplete: true })), [complete])
    assert.equal(repo.countJobs({ jdComplete: false }), 5)
    assert.equal(repo.countJobs({ jdComplete: true }) + repo.countJobs({ jdComplete: false }), repo.countJobs())
  }))

  it('only uses explicit grade_limit years, preserving unknown by default and matching ranges', () => fixture((repo, insert) => {
    const exact = insert({ grade_limit: '2027届' })
    const range = insert({ grade_limit: '2026-2028届' })
    const chineseRange = insert({ grade_limit: '2026 年至 2028 年应届毕业生' })
    const unknown = insert({ grade_limit: null, description: '2028届' })
    const nonYear = insert({ grade_limit: '本科在读' })
    insert({ grade_limit: '2026/2028届', description: '2027届' })
    insert({ grade_limit: '2028届' })
    assert.deepEqual(ids(repo.listJobs({ gradYear: 2027 })), [exact, range, chineseRange, unknown, nonYear])
    assert.deepEqual(ids(repo.listJobs({ gradYear: 2027, includeUnknown: false })), [exact, range, chineseRange])
    assert.equal(repo.countJobs({ gradYear: 2027, includeUnknown: false }), 3)
  }))

  it('preserves original filters and applies new filters in list/count identically', () => fixture((repo, insert) => {
    const companyId = repo.resolveCompany('示例公司').id
    const filter = { companyId, company: '示例', status: ['OPEN'], internshipType: 'daily', recruitType: ['summer'], location: '北京', deadlineBefore: '2026-12-31', minScore: 60, skill: 'SQL', since: '2026-09-01', updatedAfter: '2026-10-15', daysPerWeekMax: 3, jdComplete: true }
    const hit = insert({ company_id: companyId, deadline: '2026-12-01' })
    insert({ company_id: companyId, deadline: '2026-12-01', archived: 1 })
    insert({ company_id: companyId, deadline: '2026-12-01', days_per_week: 4 })
    insert({ company_id: companyId, deadline: '2026-12-01', days_per_week: null })
    insert({ company_id: companyId, deadline: '2026-12-01', updated_at: '2026-10-01' })
    insert({ company_id: companyId, deadline: null })
    const page = repo.queryPage(filter)
    assert.deepEqual(ids(page.items), [hit])
    assert.equal(page.total, 1)
    assert.equal(repo.countJobs({ ...filter, archived: true }), 2)
    assert.equal(repo.listJobs({ archived: true }).length, 6)
    assert.ok(Array.isArray(repo.listJobs()))
    assert.deepEqual(repo.searchJobIds(''), [])
  }))
})
