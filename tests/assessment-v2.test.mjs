import test from 'node:test'
import assert from 'node:assert/strict'
import { assessJob360 } from '../host/assessment.js'
import { analyzeMatch } from '../host/domain.js'

const now = '2026-11-17T12:00:00.000Z'
const profile = {
  grad_year: 2027, degree: '本科', weekly_days: 5,
  availability_start: '2026-12-01', availability_end: '2027-06-30',
  cities: ['北京'], target_roles: ['产品'], skills: [{ name: 'SQL', verified: true }],
  onboarded: true,
}
const job = {
  id: 'job-1', title: '产品实习生', grade_limit: '2026-2028届',
  location: '北京', days_per_week: 4, start_date: '2026-12-01', duration: '至少3个月',
  description: '负责产品需求分析。协助用户访谈。参与数据分析。',
  requirements: '本科及以上学历，熟悉 SQL。', skills: ['SQL'], status: 'OPEN',
}
const observation = (patch = {}) => ({
  status: 'OPEN', source_type: 'official_careers',
  source_url: 'https://careers.example.com/jobs/1',
  evidence: '该岗位目前接受申请', verified_at: '2026-11-16T12:00:00.000Z', ...patch,
})
const assess = (j = job, p = profile, extra = {}) => assessJob360({ job: j, profile: p, now, ...extra })
const check = (r, key) => r.eligibility.checks.find((c) => c.key === key)

test('graduation intervals include middle years; profile remains explicitly unconfirmed', () => {
  const r = assess()
  assert.deepEqual(check(r, 'graduationYear').allowedYears, [2026, 2027, 2028])
  assert.equal(check(r, 'graduationYear').comparison, 'match')
  assert.equal(check(r, 'graduationYear').status, 'provisional')
  assert.equal(r.profileConfirmation, 'unconfirmed')
  assert.equal(r.eligibility.profileConfirmation, 'unconfirmed')
  assert.equal(r.eligibility.status, 'provisional')
})

test('graduation sets do not invent intermediate years', () => {
  const r = assess({ ...job, grade_limit: '2026、2028届' })
  assert.deepEqual(check(r, 'graduationYear').allowedYears, [2026, 2028])
  assert.equal(check(r, 'graduationYear').comparison, 'mismatch')
  assert.equal(check(r, 'graduationYear').status, 'provisional')
  assert.ok(r.decision.risks.some((s) => s.includes('毕业年份')))
})

test('each missing side is unknown, not failed; empty inputs are supported', () => {
  const blank = assessJob360({ now })
  assert.ok(blank.eligibility.checks.every((c) => c.status === 'unknown' && c.comparison === 'unknown'))
  const noProfile = assess(job, {})
  assert.ok(noProfile.eligibility.checks.every((c) => c.status === 'unknown'))
  const noJob = assess({}, profile)
  assert.ok(noJob.eligibility.checks.every((c) => c.status === 'unknown'))
  assert.ok(!JSON.stringify(blank.eligibility).includes('fail'))
  assert.equal(assessJob360({ job: null, profile: null, now }).profileConfirmation, 'unconfirmed')
})

test('city preferences affect Fit but never appear as hard eligibility', () => {
  const preferred = assess()
  const otherCity = assess({ ...job, location: '深圳' })
  assert.deepEqual(otherCity.eligibility, preferred.eligibility)
  assert.ok(otherCity.fit.breakdown.logistics < preferred.fit.breakdown.logistics)
  assert.ok(!otherCity.eligibility.checks.some((c) => /地点|城市/.test(c.label)))
})

test('degree, weekly days, start and duration are individual provisional comparisons', () => {
  const r = assess({ ...job, requirements: '硕士及以上学历，熟悉 SQL。', days_per_week: 5 }, {
    ...profile, degree: '本科', weekly_days: 3, availability_start: '2026-12-10', availability_end: '2027-01-01',
  })
  for (const key of ['degree', 'weeklyDays', 'startDate', 'duration']) {
    assert.equal(check(r, key).comparison, 'mismatch')
    assert.equal(check(r, key).status, 'provisional')
  }
  assert.equal(assess({ ...job, requirements: '本科及以上学历。' }, { ...profile, degree: '博士' }).eligibility.checks[1].comparison, 'match')
})

test('preferred education and attendance are not treated as hard requirements', () => {
  const r = assess({ description: '负责数据分析。', requirements: '硕士优先；每周5天优先。' }, profile)
  assert.equal(check(r, 'degree').comparison, 'unknown')
  assert.equal(check(r, 'weeklyDays').comparison, 'unknown')
})

test('camelCase aliases and JD year/attendance requirements are supported', () => {
  const r = assess({ title: '实习', description: '负责 SQL 数据分析。', requirements: '2026至2028年毕业；本科及以上；每周至少四天。', startDate: '2026-12-01', duration: '3个月' }, {
    gradYear: 2027, degree: '本科', weeklyDays: 4, availabilityStart: '2026-12-01', availabilityEnd: '2027-06-01',
  })
  assert.equal(check(r, 'graduationYear').comparison, 'match')
  assert.equal(check(r, 'weeklyDays').comparison, 'match')
  assert.equal(check(r, 'startDate').comparison, 'match')
})

test('empty JD cannot become reliable or generate title-based tasks even with skills', () => {
  const r = assess({ title: '负责全球增长的高级 SQL 分析师', skills: ['SQL'] })
  assert.equal(r.fit.reliable, false)
  assert.equal(r.evidence.textComplete, false)
  assert.deepEqual(r.taskAnalysis.tasks, [])
  assert.ok(r.fit.uncertainty.some((s) => s.includes('JD 无正文')))
  assert.ok(r.unknowns.length)
  assert.equal(Number.isInteger(r.fit.score), true)
  assert.ok(r.fit.scoreMeaning.includes('不是录用概率'))
})

test('Fit reuses analyzeMatch scores without legacy hard blocks and freshness scoring', () => {
  const r = assess()
  const expected = analyzeMatch(profile, job, { freshness: 0 })
  assert.equal(r.fit.score, Math.round(expected.score))
  assert.equal('freshness' in r.fit.breakdown, false)
  assert.equal(r.fit.weights.freshness, 0)
  assert.equal('hardBlocks' in r.fit, false)
  assert.ok(Array.isArray(r.fit.reasons.matched))
})

test('experiences supply actual resume material, not invented credentials', () => {
  const noExp = assess()
  const withExp = assess(job, profile, { experiences: [{ id: 'e1', role: '研究助理', bullets: ['使用 SQL 完成报表'], verified: false }] })
  assert.ok(withExp.fit.breakdown.experience > noExp.fit.breakdown.experience)
  assert.equal(withExp.profileConfirmation, 'unconfirmed')
})

test('complete JD and real official source are not evidence that a role is open', () => {
  const r = assess({ ...job, sources: [{ source_type: 'official_careers', source_url: 'https://careers.example.com/jobs/1', verification_status: 'verified', claim_type: 'job_opening' }] })
  assert.equal(r.evidence.textComplete, true)
  assert.equal(r.evidence.officialSource, true)
  assert.equal(r.evidence.verifiedOpen, false)
  assert.equal(r.evidence.statusAssessment, 'open-unverified')
  assert.ok(r.taskAnalysis.tasks.every((t) => t.label === 'official-jd'))
})

test('fresh latest official status history with evidence and valid URL verifies OPEN', () => {
  const r = assess({ ...job, history: [observation()] })
  assert.equal(r.evidence.statusAssessment, 'verified_open')
  assert.equal(r.evidence.verifiedOpen, true)
  assert.equal(r.evidence.latestObservation.ageDays, 1)
  assert.equal(r.evidence.latestObservation.valid, true)
  // A source label is not manufactured from status observations.
  assert.ok(r.taskAnalysis.tasks.every((t) => t.label === 'source-jd'))
})

test('seven-day inclusive freshness uses actual duration, not rounded days', () => {
  assert.equal(assess({ ...job, history: [observation({ verified_at: '2026-11-10T12:00:00.000Z' })] }).evidence.statusAssessment, 'verified_open')
  assert.equal(assess({ ...job, history: [observation({ verified_at: '2026-11-10T11:59:59.000Z' })] }).evidence.statusAssessment, 'stale')
})

test('old OPEN stays stale, updated timestamp and knowledge cannot refresh it', () => {
  const j = { ...job, status_verified_at: '2026-10-01', updated_at: now, history: [observation({ verified_at: '2026-10-01T00:00:00Z' })] }
  const r = assess(j, profile, { knowledge: [{ platform: 'official', body: '现在开放', updated_at: now }] })
  assert.equal(r.evidence.statusAssessment, 'stale')
  assert.equal(r.evidence.verifiedOpen, false)
  assert.equal(assess({ ...job, status_verified_at: '2026-10-01', updated_at: now }).evidence.statusAssessment, 'stale')
})

test('invalid URLs, absent evidence, unofficial and future observations cannot verify OPEN', () => {
  for (const patch of [
    { source_url: 'not a url' }, { source_url: 'javascript:alert(1)' }, { evidence: '   ' },
    { source_type: 'job_board' }, { verified_at: '2026-11-18T12:00:00Z' }, { verified_at: '2026-02-30' },
  ]) {
    assert.notEqual(assess({ ...job, history: [observation(patch)] }).evidence.statusAssessment, 'verified_open')
  }
})

test('latest observation is authoritative; older valid OPEN cannot override newer CLOSED or unsupported claim', () => {
  const r = assess({ ...job, history: [observation(), observation({ status: 'CLOSED', verified_at: '2026-11-17T10:00:00Z' })] })
  assert.equal(r.evidence.statusAssessment, 'verified_closed')
  const invalid = assess({ ...job, history: [observation(), observation({ source_type: 'manual', verified_at: '2026-11-17T10:00:00Z' })] })
  assert.equal(invalid.evidence.statusAssessment, 'open-unverified')
})

test('task analysis quotes only explicit JD task sentences, first five, with honest labels', () => {
  const description = '岗位职责：\n1. 负责需求分析。\n2. 协助访谈。\n3. 开发报表。\n4. 维护文档。\n5. 推进测试。\n6. 完成复盘。\n本科及以上，熟悉 SQL。'
  const r = assess({ ...job, description })
  assert.equal(r.taskAnalysis.tasks.length, 5)
  assert.equal(r.taskAnalysis.tasks[0].text, '负责需求分析')
  assert.ok(r.taskAnalysis.tasks.every((t) => t.label === 'source-jd' && t.sourceField === 'description'))
  assert.ok(!r.taskAnalysis.tasks.some((t) => t.text.includes('熟悉') || t.text.includes('复盘')))
})

test('decision is material-based and input job/profile/history remain unchanged', () => {
  const input = { job: { ...job, history: [observation()] }, profile: { ...profile }, experiences: [], knowledge: [], now }
  const snapshot = JSON.stringify(input)
  const r = assessJob360(input)
  assert.equal(JSON.stringify(input), snapshot)
  for (const key of ['reasons', 'risks', 'unknowns', 'nextActions']) assert.ok(Array.isArray(r.decision[key]))
  assert.ok(r.decision.nextActions.some((s) => s.includes('自述')))
  assert.deepEqual(assessJob360(input), r)
})

test('onboarding, completeness and arbitrary profile verified flags do not verify qualifications', () => {
  const r = assess(job, { ...profile, onboarded: 1, completeness: { percent: 100 }, verified: true, grad_year_verified: true })
  assert.equal(r.profileConfirmation, 'unconfirmed')
  assert.ok(r.eligibility.checks.every((c) => c.profileConfirmation === 'unconfirmed'))
})

test('invalid now reports uncertainty, never fresh status', () => {
  const r = assess({ ...job, history: [observation()] }, profile, { now: 'invalid' })
  assert.equal(r.evidence.verifiedOpen, false)
  assert.ok(r.unknowns.some((s) => s.includes('评估时间无效')))
})
