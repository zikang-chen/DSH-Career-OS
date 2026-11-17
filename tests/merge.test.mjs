// 多源简历合并：去重、冲突检测、批量落库。全部离线断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditVault, dedupeBullets, experienceKey, mergeExperience, planMerge, sameBullet } from '../host/merge.js'
import { planTailor } from '../host/tailor.js'
import { makeEnv } from './helpers.mjs'

const base = {
  kind: 'internship',
  organization: '某科技有限公司',
  role: '数据分析实习生',
  start_at: '2025-07',
  end_at: '2025-09',
  bullets: ['用 SQL 完成留存分析', '用 Python 做用户分群'],
  skills: ['SQL'],
  tags: [],
  links: [],
}

describe('bullet dedupe', () => {
  it('treats a rewritten bullet as the same thing', () => {
    assert.equal(sameBullet('用 SQL 完成留存分析', '用 SQL 完成留存分析'), true)
    assert.equal(sameBullet('用 SQL 完成留存分析，定位 3 个流失点', '用 SQL 完成留存分析'), true, 'substring rewrite')
    assert.equal(sameBullet('用 SQL 完成留存分析', '独立完成 React 前端开发'), false)
  })

  it('keeps the first wording and reports what was merged', () => {
    const result = dedupeBullets(['用 SQL 完成留存分析'], ['用 SQL 完成留存分析，定位 3 个流失点', '组织 3 场线下活动'])
    assert.equal(result.bullets.length, 2)
    assert.deepEqual(result.added, ['组织 3 场线下活动'])
    assert.equal(result.merged.length, 1)
    assert.equal(result.bullets[0], '用 SQL 完成留存分析', 'earlier wording wins')
  })
})

describe('merging one experience', () => {
  it('unions bullets/skills and fills missing fields without inventing', () => {
    const incoming = { ...base, bullets: ['组织 3 场线下活动'], skills: ['Python'], location: '北京' }
    const merged = mergeExperience(base, incoming)
    assert.deepEqual(merged.addedBullets, ['组织 3 场线下活动'])
    assert.equal(merged.patch.bullets.length, 3)
    assert.ok(merged.patch.skills.includes('Python'))
    assert.equal(merged.patch.location, '北京', 'missing field is filled')
    assert.equal(merged.conflicts.length, 0)
  })

  it('reports a conflict instead of silently overwriting a different date', () => {
    const merged = mergeExperience(base, { ...base, start_at: '2025-06' })
    assert.equal(merged.conflicts.length, 1)
    assert.equal(merged.conflicts[0].field, 'start_at')
    assert.equal(merged.patch.start_at, undefined, 'conflicting value is NOT written')
  })
})

describe('merge plan', () => {
  it('creates new, updates existing, and never duplicates', () => {
    const existing = [{ ...base, id: 'e1' }]
    const plan = planMerge({
      existing,
      incoming: [
        { ...base, bullets: ['用 SQL 完成留存分析', '新增一条数据看板'] },
        { ...base, organization: '另一家公司', role: '产品实习生' },
      ],
    })
    assert.equal(plan.summary.create, 1)
    assert.equal(plan.summary.update, 1)
    assert.equal(plan.updates[0].addedBullets.length, 1)
    assert.equal(plan.summary.conflict, 0)
  })

  it('is idempotent: applying the same batch twice yields no new creates', () => {
    const first = planMerge({ existing: [], incoming: [base] })
    assert.equal(first.summary.create, 1)
    const applied = { ...base, id: 'e-new' }
    const second = planMerge({ existing: [applied], incoming: [base] })
    assert.equal(second.summary.create, 0)
    assert.equal(second.summary.update + second.summary.duplicate, 1)
  })

  it('flags same-company different-period entries as conflicts, not merges', () => {
    const existing = [{ ...base, id: 'e1' }]
    const plan = planMerge({ existing, incoming: [{ ...base, start_at: '2024-07', end_at: '2024-09' }] })
    // 期不同 => 身份键不同 => 视为另一段（新建），不会误并
    assert.equal(plan.summary.create, 1)
    assert.equal(plan.summary.update, 0)
  })

  it('keeps genuinely different roles apart', () => {
    const plan = planMerge({
      existing: [{ ...base, id: 'e1' }],
      incoming: [{ ...base, role: '产品经理实习生' }],
    })
    assert.equal(plan.summary.create, 1)
  })

  it('never generates content that was not supplied', () => {
    const plan = planMerge({ existing: [], incoming: [{ ...base, bullets: ['只写了这一条'] }] })
    const text = JSON.stringify(plan)
    assert.ok(plan.creates[0].incoming.bullets.length === 1)
    assert.ok(!/编造|fabricat/i.test(text))
  })
})

describe('vault audit', () => {
  it('surfaces empty-bullet entries and unverified rows', () => {
    const audit = auditVault([
      { id: 'a', kind: 'internship', organization: '某公司', bullets: ['x'], verified: false },
      { id: 'b', kind: 'project', organization: '某项目', bullets: [], verified: true },
    ])
    assert.equal(audit.total, 2)
    assert.deepEqual(audit.emptyBullets, ['b'])
    assert.equal(audit.unverified, 1)
  })
})

describe('batch apply into the vault', () => {
  it('applies creates and updates in one transaction and reports counts', () => {
    const env = makeEnv()
    try {
      const seeded = env.repos.profile.addExperience(base)
      const plan = planMerge({
        existing: env.repos.profile.listExperiences(),
        incoming: [
          { ...base, bullets: ['用 SQL 完成留存分析', '新增一条数据看板'] },
          { ...base, organization: '另一家公司', role: '产品实习生', bullets: ['做需求分析'] },
        ],
      })
      const dry = env.repos.profile.applyVaultOps({ creates: plan.creates, updates: plan.updates }, { dryRun: true })
      assert.equal(dry.dryRun, true)
      assert.equal(env.repos.profile.listExperiences().length, 1, 'dryRun writes nothing')

      const applied = env.repos.profile.applyVaultOps({ creates: plan.creates, updates: plan.updates })
      assert.equal(applied.created, 1)
      assert.equal(applied.updated, 1)
      assert.equal(applied.failed.length, 0)
      const rows = env.repos.profile.listExperiences()
      assert.equal(rows.length, 2)
      const updated = rows.find((row) => row.id === seeded.id)
      assert.equal(updated.bullets.length, 3, 'bullets were merged in')
    } finally {
      env.cleanup()
    }
  })

  it('keeps raw source text per version so merges can be re-derived', () => {
    const env = makeEnv()
    try {
      env.repos.profile.addResume({ label: 'v1', rawText: '第一版内容', sourceType: 'upload' })
      env.repos.profile.addResume({ label: 'v2', rawText: '第二版内容更长一些', sourceType: 'upload' })
      const sources = env.repos.profile.rawSources()
      assert.equal(sources.length, 2)
      assert.equal(sources[0].text, '第一版内容')
      assert.equal(sources[0].chars, 5)
    } finally {
      env.cleanup()
    }
  })
})

describe('build for a job with forced include/exclude', () => {
  const job = { id: 'j1', company_name: '字节跳动', title: 'AI 产品经理实习生', skills: ['Python', '数据分析'], description: '需要能判断模型能力边界的产品', requirements: '' }
  const experiences = [
    { id: 'edu', kind: 'education', organization: '东南大学', role: '硕士', start_at: '2025-09', end_at: '2028-06', bullets: ['计算机技术'], skills: [], tags: [] },
    { id: 'r1', kind: 'research', organization: 'MSRA', role: '研究', start_at: '2026-07', end_at: '2026-11', bullets: ['用 Python 做数据分析', '系统实现'], skills: ['Python', '数据分析'], tags: [] },
    { id: 'a1', kind: 'activity', organization: '闲鱼', role: '独立运营', start_at: '2021-09', end_at: '2024-10', bullets: ['47 万流水', '内容运营'], skills: ['运营'], tags: [] },
  ]

  it('honours includeIds even when relevance is low', () => {
    const plan = planTailor({ experiences, job, maxEntries: 1, includeIds: ['a1'] })
    const ids = plan.selected.map((s) => s.experienceId)
    assert.ok(ids.includes('a1'), 'forced include must survive the budget')
    assert.ok(ids.includes('edu'), 'education is always kept')
  })

  it('honours excludeIds', () => {
    const plan = planTailor({ experiences, job, excludeIds: ['a1'] })
    assert.ok(!plan.selected.map((s) => s.experienceId).includes('a1'))
  })
})
