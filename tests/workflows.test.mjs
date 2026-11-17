// 高层任务工作流：编排已有纯函数，不复制业务逻辑。全部离线。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findJobsForMe, jdCompleteness, prepResumeForJob, summarizeApplications } from '../host/workflows.js'

const profile = {
  display_name: '陈同学', grad_year: 2028, degree: '硕士', major: '计算机技术',
  cities: ['北京', '上海'], weekly_days: 4, internship_types: ['daily', 'summer'],
  target_roles: ['AI 产品经理'], excluded: ['销售'],
  skills: [{ name: 'Python' }, { name: 'SQL' }],
}
const mkJob = (id, title, extra = {}) => ({
  id, company_name: '腾讯', title, location: '北京', status: 'OPEN',
  description: '负责 AI 产品规划与需求分析', requirements: '本科及以上，每周 4 天', skills: ['Python'],
  ...extra,
})

describe('jd completeness', () => {
  it('classifies complete / partial / summary-only / missing', () => {
    assert.equal(jdCompleteness({ description: 'a', requirements: 'b' }).level, 'complete')
    assert.equal(jdCompleteness({ description: 'a' }).level, 'partial')
    assert.equal(jdCompleteness({ apply_url: 'https://x' }).level, 'summary-only')
    assert.equal(jdCompleteness({}).level, 'missing')
  })
})

describe('find jobs for me', () => {
  it('ranks by score, sinks hard mismatches, and flags incomplete JD', () => {
    const jobs = [
      mkJob('1', 'AI 产品经理', { description: 'AI 产品规划', requirements: '每周 4 天' }),
      mkJob('2', '销售代表', { description: '', requirements: '', apply_url: 'https://x' }),
      mkJob('3', '算法工程师', { description: '', requirements: '', apply_url: 'https://y' }),
    ]
    const result = findJobsForMe({ profile, jobs, limit: 5 })
    assert.equal(result.ok, true)
    assert.equal(result.count, 3)
    // 销售命中排除条件 → 硬性不符，必须排最后
    assert.equal(result.recommendations[result.recommendations.length - 1].title, '销售代表')
    assert.ok(result.recommendations.some((r) => r.hardBlocks.length > 0))
    // JD 不完整的岗位要被标注
    assert.ok(result.recommendations.some((r) => r.jd.includes('仅列表摘要')))
    assert.ok(result.caveats.some((c) => c.includes('JD 不完整')))
  })

  it('refuses without a profile instead of faking a ranking', () => {
    const result = findJobsForMe({ profile: null, jobs: [mkJob('1', 'x')] })
    assert.equal(result.ok, false)
    assert.match(result.error, /画像/)
  })

  it('handles an empty job pool honestly', () => {
    const result = findJobsForMe({ profile, jobs: [] })
    assert.equal(result.ok, true)
    assert.equal(result.count, 0)
    assert.match(result.note, /空的/)
  })
})

describe('summarize applications', () => {
  it('reports funnel plus overdue / stale actions', () => {
    const applications = [
      { id: 'a1', company_name: '腾讯', job_title: 'PM', status: 'applied', applied_at: '2026-09-01', next_action: 'follow up', next_action_at: '2026-09-05' },
      { id: 'a2', company_name: '字节', job_title: 'PM', status: 'offer', applied_at: '2026-09-10' },
    ]
    const events = [{ application_id: 'a1', to_status: 'applied' }, { application_id: 'a2', to_status: 'applied' }, { application_id: 'a2', to_status: 'offer' }]
    const result = summarizeApplications({ applications, events, now: '2026-10-01T00:00:00Z' })
    assert.equal(result.total, 2)
    assert.equal(result.active, 1)
    assert.equal(result.funnel.submitted, 2)
    assert.ok(result.needsAction.some((r) => r.id === 'a1' && r.overdue))
  })

  it('says nothing needs action when the pipeline is empty', () => {
    const result = summarizeApplications({ applications: [], events: [], now: '2026-10-01T00:00:00Z' })
    assert.equal(result.needsAction.length, 0)
    assert.match(result.note, /没有需要/)
  })
})

describe('prep resume for job', () => {
  const experiences = [
    { id: 'e1', kind: 'education', organization: '东南大学', role: '硕士', start_at: '2025-09', end_at: '2028-06', bullets: ['计算机技术'], skills: [] },
    { id: 'a1', kind: 'activity', organization: '闲鱼', role: '运营', start_at: '2021-09', end_at: '2024-10', bullets: ['47 万流水', '用 Python 做分析'], skills: ['Python'] },
  ]

  it('returns selection, gaps and quality without inventing content', () => {
    const job = mkJob('j1', 'AI 产品经理', { skills: ['Python', 'Figma'] })
    const result = prepResumeForJob({ profile, experiences, documents: [], job })
    assert.equal(result.ok, true)
    assert.ok(result.selection.keep.length >= 1)
    assert.ok(Array.isArray(result.gaps))
    assert.ok(result.quality.summary)
    assert.equal(result.jdCompleteness.level, 'complete')
    assert.equal(result.caveat, null)
    assert.ok(!/已生成|为你写/.test(JSON.stringify(result)))
  })

  it('warns when the JD is incomplete so conclusions are not over-trusted', () => {
    const job = mkJob('j2', 'AI 产品经理', { description: '', requirements: '', apply_url: 'https://x' })
    const result = prepResumeForJob({ profile, experiences, documents: [], job })
    assert.equal(result.jdCompleteness.level, 'summary-only')
    assert.match(result.caveat, /JD 不完整/)
  })
})
