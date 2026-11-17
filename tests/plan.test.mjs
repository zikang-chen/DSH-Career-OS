// 校招时间线与作战计划：全部为确定性规则，可在无网络、无数据库外设的情况下断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildBrief, buildPlan, buildTimeline, phaseStatus, seasonRuleSet } from '../host/plan.js'
import { makeEnv } from './helpers.mjs'

describe('season timeline rules', () => {
  it('anchors the autumn season to the year before graduation', () => {
    const rules = seasonRuleSet(2027)
    assert.equal(rules.autumnYear, 2026)
    const byKey = Object.fromEntries(rules.phases.map((p) => [p.key, p]))
    assert.equal(byKey.autumn_early.start, '2026-07-01')
    assert.equal(byKey.autumn_main.start, '2026-09-01')
    assert.equal(byKey.spring_main.start, '2027-03-01')
    assert.equal(byKey.graduation_window.end, '2027-07-31')
  })

  it('returns no rules without a graduation year', () => {
    assert.equal(seasonRuleSet(null), null)
    assert.equal(buildTimeline(undefined), null)
  })

  it('locates the current phase and the next one', () => {
    const inAutumn = buildTimeline(2027, '2026-10-01')
    assert.equal(inAutumn.current.key, 'autumn_main')
    assert.equal(inAutumn.next.key, 'autumn_supplement')
    assert.ok(inAutumn.current.daysToEnd > 0)

    const inSpring = buildTimeline(2027, '2027-03-15')
    assert.equal(inSpring.current.key, 'spring_main')

    const beforeAnything = buildTimeline(2027, '2026-01-10')
    assert.equal(beforeAnything.current, null)
    assert.equal(beforeAnything.next.key, 'summer_intern_apply')
    assert.ok(beforeAnything.next.daysToStart > 0)
  })

  it('classifies a window boundary consistently', () => {
    const phase = { start: '2026-09-01', end: '2026-11-15' }
    assert.equal(phaseStatus(phase, '2026-08-31').status, 'upcoming')
    assert.equal(phaseStatus(phase, '2026-09-01').status, 'current')
    assert.equal(phaseStatus(phase, '2026-11-15').status, 'current')
    assert.equal(phaseStatus(phase, '2026-11-16').status, 'past')
  })
})

describe('personalized action plan', () => {
  it('puts blocking gaps first for a brand-new user', () => {
    const plan = buildPlan({
      profile: {},
      completeness: { percent: 0, checks: [{ key: 'resume', label: '简历', done: false }] },
      jobs: [],
      applications: [],
      followUps: { overdue: [], stale: [] },
      events: [],
      now: '2026-09-20',
    })
    assert.equal(plan.actions[0].priority, 1)
    assert.ok(plan.actions.some((a) => a.title.includes('毕业年份')))
    assert.ok(plan.actions.some((a) => a.title.includes('补齐画像')))
    assert.ok(plan.actions.some((a) => a.title.includes('简历')))
    assert.equal(plan.readiness.appliedCount, 0)
  })

  it('derives a closing-soon action from real deadlines', () => {
    const plan = buildPlan({
      profile: { grad_year: 2027 },
      completeness: { percent: 90, checks: [{ key: 'resume', label: '简历', done: true }] },
      jobs: [
        { id: 'j1', company_name: '示例科技', title: '数据分析实习生', status: 'OPEN', deadline: '2026-09-25', match_score: 80 },
        { id: 'j2', company_name: '示例科技', title: '产品经理实习生', status: 'OPEN', deadline: '2027-03-01', match_score: 70 },
      ],
      applications: [],
      followUps: { overdue: [], stale: [] },
      events: [],
      now: '2026-09-20',
    })
    const closing = plan.actions.find((a) => a.title.includes('14 天内截止'))
    assert.ok(closing, 'closing action missing')
    assert.match(closing.title, /1 个/)
    assert.match(closing.how, /09-25/)
    assert.equal(plan.readiness.closingSoon, 1)
  })

  it('raises the application target during the main autumn batch', () => {
    const plan = buildPlan({
      profile: { grad_year: 2027 },
      completeness: { percent: 90, checks: [{ key: 'resume', label: '简历', done: true }] },
      jobs: [{ id: 'j1', company_name: 'A', title: 'B', status: 'OPEN', match_score: 60 }],
      applications: [{ id: 'a1', status: 'applied' }],
      followUps: { overdue: [], stale: [] },
      events: [],
      now: '2026-10-01',
    })
    assert.equal(plan.timeline.current.key, 'autumn_main')
    assert.equal(plan.readiness.targetApplied, 12)
    assert.ok(plan.actions.some((a) => a.title.includes('提到 12 个')))
  })

  it('surfaces overdue follow-ups and registered company events', () => {
    const plan = buildPlan({
      profile: { grad_year: 2027 },
      completeness: { percent: 90, checks: [{ key: 'resume', label: '简历', done: true }] },
      jobs: [{ id: 'j1', company_name: 'A', title: 'B', status: 'OPEN', match_score: 60 }],
      applications: [{ id: 'a1', status: 'applied' }],
      followUps: { overdue: [{ id: 'a1' }], stale: [{ id: 'a2' }] },
      events: [{ title: '网申截止', starts_at: '2026-10-20', company_name: '示例科技', source: 'official', note: '' }],
      now: '2026-10-01',
    })
    assert.ok(plan.actions.some((a) => a.title.includes('逾期的下一步')))
    const eventAction = plan.actions.find((a) => a.title.includes('网申截止'))
    assert.ok(eventAction)
    assert.match(eventAction.why, /官方公布/)
  })
})

describe('comprehensive brief', () => {
  const basePlan = buildPlan({
    profile: { grad_year: 2027, school: '示例大学', degree: '本科', cities: ['北京'], target_roles: ['数据分析'] },
    completeness: { percent: 86, checks: [{ key: 'resume', label: '简历', done: true }] },
    jobs: [{ id: 'j1', company_name: '示例科技', title: '数据分析实习生', status: 'OPEN', deadline: '2026-10-31', match_score: 78, location: '北京', apply_url: 'https://jobs.example.com/p/1' }],
    applications: [{ id: 'a1', status: 'applied' }],
    followUps: { overdue: [], stale: [] },
    events: [],
    now: '2026-09-20',
  })

  it('covers every promised section', () => {
    const brief = buildBrief({
      profile: { grad_year: 2027, school: '示例大学', cities: ['北京'], target_roles: ['数据分析'] },
      completeness: { percent: 86, checks: [{ key: 'resume', label: '简历', done: true }] },
      plan: basePlan,
      jobs: [{ company_name: '示例科技', title: '数据分析实习生', status: 'OPEN', match_score: 78, location: '北京', apply_url: 'https://jobs.example.com/p/1', recruit_type: 'autumn_campus' }],
      applications: [],
      signals: [],
      units: [],
      bar: { hard: [{ text: '2027 届本科' }], preferred: [], observed: [], unverified: [] },
      now: '2026-09-20',
    })
    for (const heading of ['一、现在该做什么', '二、春招秋招时间线', '三、你的情况与求职意愿', '四、岗位池与优先级',
      '五、招聘门槛', '六、市场与行业前景', '七、业务部门与成长', '八、未知与待核实', '九、未来 4 周动作']) {
      assert.ok(brief.markdown.includes(heading), `missing section: ${heading}`)
    }
    assert.ok(brief.markdown.includes('秋招正式批'))
    assert.ok(brief.markdown.includes('2027 届本科'), 'hard requirement quoted')
    assert.ok(brief.markdown.includes('经验值'), 'timeline caveat present')
  })

  it('lists absent evidence as unknown instead of inventing it', () => {
    const brief = buildBrief({
      profile: { grad_year: 2027 },
      completeness: { percent: 40, checks: [{ key: 'resume', label: '简历', done: false }] },
      plan: basePlan,
      jobs: [],
      applications: [],
      signals: [],
      units: [],
      bar: { hard: [], preferred: [], observed: [], unverified: [] },
      now: '2026-09-20',
    })
    assert.ok(brief.missing.some((m) => m.includes('市场与行业前景')))
    assert.ok(brief.missing.some((m) => m.includes('业务部门')))
    assert.ok(brief.missing.some((m) => m.includes('岗位池')))
    assert.ok(brief.markdown.includes('还没有任何市场信号'), 'must say the data is missing')
    assert.ok(!/增长强劲|前景广阔|预计增长\d/.test(brief.markdown), 'must not fabricate market claims')
  })

  it('reports evidence levels for recorded signals', () => {
    const brief = buildBrief({
      profile: { grad_year: 2027 },
      completeness: { percent: 90, checks: [{ key: 'resume', label: '简历', done: true }] },
      plan: basePlan,
      jobs: [],
      applications: [],
      signals: [
        { claim: '某部门 2026 年扩招 30%', direction: 'positive', evidence_level: 'A', source: '公司财报', as_of: '2026-08-01', horizon: '6-18m' },
        { claim: '行业价格战加剧', direction: 'negative', evidence_level: 'C', source: '媒体报道', as_of: '2026-07-01' },
      ],
      units: [{ id: 'u1', name: '增长产品部', business: '用户增长', strategic_role: 'core', data_as_of: '2026-08-01' }],
      bar: { hard: [], preferred: [], observed: [], unverified: [] },
      now: '2026-09-20',
    })
    assert.ok(brief.markdown.includes('A 官方一手'))
    assert.ok(brief.markdown.includes('C 单一可溯源'))
    assert.ok(brief.markdown.includes('增长产品部'))
    assert.ok(brief.markdown.includes('偏正面'))
    assert.ok(brief.markdown.includes('偏负面'))
  })
})

describe('plan storage wiring', () => {
  it('stores events, units and signals', () => {
    const env = makeEnv()
    try {
      const event = env.repos.intel.addEvent({ title: '秋招网申截止', startsAt: '2026-10-20', company: '示例科技', source: 'official' })
      assert.equal(event.evidence_level, 'A')
      assert.equal(env.repos.intel.listEvents({ from: '2026-10-01' }).length, 1)

      const company = env.repos.jobs.resolveCompany('示例科技')
      const unit = env.repos.intel.upsertUnit({ companyId: company.id, name: '增长产品部', strategicRole: 'core', business: '用户增长' })
      assert.equal(unit.strategic_role, 'core')
      const again = env.repos.intel.upsertUnit({ companyId: company.id, name: '增长产品部', headcountNote: '约 40 人' })
      assert.equal(again.id, unit.id, 'upsert by (company, name)')

      const signal = env.repos.intel.addSignal({ scope: 'company', companyId: company.id, claim: '该部门 2027 届计划扩招', direction: 'positive', evidenceLevel: 'A', source: '招聘官网' })
      assert.equal(signal.evidence_level, 'A')
      assert.equal(env.repos.intel.listSignals({ companyId: company.id }).length, 1)
    } finally {
      env.cleanup()
    }
  })

  it('rejects an event without a date', () => {
    const env = makeEnv()
    try {
      assert.throws(() => env.repos.intel.addEvent({ title: '缺日期' }), /startsAt/)
    } finally {
      env.cleanup()
    }
  })
})
