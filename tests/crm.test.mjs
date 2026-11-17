// 网申信息卡 + 投递漏斗 + 投递快照。全部离线断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildApplyCard, pickEducation, renderApplyCardText } from '../host/applycard.js'
import { computeFunnel, isSubmitted, maxStageOf, stageIndexOf } from '../host/funnel.js'
import { buildSubmissionSnapshot, freezeJd } from '../host/repo/applications.js'
import { makeEnv, sampleProfile } from './helpers.mjs'

describe('apply card', () => {
  const profile = {
    ...sampleProfile(),
    display_name: '陈同学',
    phone: '13800000000',
    email: 'me@example.com',
    rank_text: '4/71',
    grad_year: 2028,
  }
  const experiences = [
    { id: 'e1', kind: 'education', organization: '东南大学', role: '计算机技术 · 硕士', start_at: '2025-09', end_at: '2028-06', bullets: ['研究方向：边缘计算'] },
    { id: 'e2', kind: 'education', organization: '某大学', role: '信息安全 · 本科', start_at: '2021-09', end_at: '2025-06', bullets: ['专业排名 4/71', 'GPA 3.72/4.0'] },
    { id: 'a1', kind: 'activity', organization: '闲鱼', role: '运营', bullets: ['TOEFL 105，累积 47 万流水'] },
  ]

  it('fills contact and education fields from the profile', () => {
    const card = buildApplyCard({ profile, experiences })
    const flat = new Map(card.groups.flatMap((g) => g.fields).map((f) => [f.key, f]))
    assert.equal(flat.get('displayName').value, '陈同学')
    assert.equal(flat.get('phone').value, '13800000000')
    assert.equal(flat.get('studyPeriod').value, '2025-09 – 2028-06', 'highest degree wins')
    assert.equal(flat.get('rank').value, '4/71')
    assert.equal(flat.get('gpa').value, '3.72/4.0', 'GPA scanned from bullets when profile lacks it')
  })

  it('reports missing fields instead of inventing values', () => {
    const card = buildApplyCard({ profile: { display_name: '只有名字' }, experiences: [] })
    assert.ok(card.missing.some((m) => m.label === '手机号'))
    const phone = card.groups.flatMap((g) => g.fields).find((f) => f.key === 'phone')
    assert.equal(phone.value, '', 'never fabricates')
    assert.ok(card.completeness.percent < 100)
  })

  it('falls back to resume text for language scores, and prefers the document vault', () => {
    const fromExperience = buildApplyCard({ profile, experiences })
    const langField = fromExperience.groups.flatMap((g) => g.fields).find((f) => f.key === 'language')
    assert.match(langField.value, /TOEFL 105/)

    const fromDocs = buildApplyCard({
      profile,
      experiences,
      documents: [{ id: 'd1', category: 'language', title: 'TOEFL 成绩单', score: 'TOEFL 110', verified: true }],
    })
    const docLang = fromDocs.groups.flatMap((g) => g.fields).find((f) => f.key === 'language')
    assert.equal(docLang.value, 'TOEFL 110', 'verified document beats resume text')
  })

  it('renders a copy-paste block that skips empty groups', () => {
    const card = buildApplyCard({ profile, experiences })
    const text = renderApplyCardText(card)
    assert.match(text, /【基本信息】/)
    assert.match(text, /姓名：陈同学/)
    assert.ok(!text.includes('undefined'))
    assert.ok(!text.includes('null'))
  })

  it('picks the highest degree for 在读起止', () => {
    const edu = pickEducation(experiences)
    assert.equal(edu.organization, '东南大学')
  })
})

describe('funnel', () => {
  const applications = [
    { id: 'a1', company_name: '字节', channel: '官网', status: 'offer', applied_at: '2026-09-01', created_at: '2026-09-01' },
    { id: 'a2', company_name: '腾讯', channel: '官网', status: 'interview_2', applied_at: '2026-09-05', created_at: '2026-09-05' },
    { id: 'a3', company_name: '美团', channel: '内推', status: 'rejected', applied_at: '2026-09-10', created_at: '2026-09-10' },
    { id: 'a4', company_name: '小米', channel: '内推', status: 'saved', created_at: '2026-09-12' },
  ]
  const events = [
    { application_id: 'a1', to_status: 'applied' },
    { application_id: 'a1', to_status: 'written_test' },
    { application_id: 'a1', to_status: 'interview_1' },
    { application_id: 'a1', to_status: 'offer' },
    { application_id: 'a2', to_status: 'applied' },
    { application_id: 'a2', to_status: 'interview_1' },
    { application_id: 'a2', to_status: 'interview_2' },
    { application_id: 'a3', to_status: 'applied' },
    { application_id: 'a3', to_status: 'written_test' },
  ]

  it('counts only submitted applications', () => {
    assert.equal(isSubmitted(applications[0]), true)
    assert.equal(isSubmitted(applications[3]), false, 'saved is not submitted')
    const funnel = computeFunnel({ applications, events, now: '2027-01-01T00:00:00Z' })
    assert.equal(funnel.submitted, 3)
    assert.equal(funnel.beforeSubmit, 1)
  })

  it('uses the highest stage ever reached, not just the current status', () => {
    assert.equal(stageIndexOf('offer'), 5)
    assert.equal(maxStageOf(applications[2], events.filter((e) => e.application_id === 'a3')), 1, 'rejected still reached written_test')
    const funnel = computeFunnel({ applications, events, now: '2027-01-01T00:00:00Z' })
    const byKey = Object.fromEntries(funnel.stages.map((s) => [s.key, s]))
    assert.equal(byKey.applied.count, 3)
    // 累进口径：到过一面必然也到过测评，所以 assessment 是 3 而不是 2。
    assert.equal(byKey.assessment.count, 3)
    assert.equal(byKey.interview_1.count, 2)
    assert.equal(byKey.offer.count, 1)
  })

  it('computes stage pass rates and names the choke point', () => {
    const funnel = computeFunnel({ applications, events, now: '2027-01-01T00:00:00Z' })
    const byKey = Object.fromEntries(funnel.stages.map((s) => [s.key, s]))
    assert.equal(byKey.applied.passRate, null, 'first stage has no previous')
    assert.equal(byKey.assessment.passRate, 100)
    assert.equal(byKey.interview_1.passRate, 66.7, '3 到测评 → 2 到一面')
    assert.ok(funnel.choke)
    assert.equal(typeof funnel.choke.dropped, 'number')
  })

  it('breaks the funnel down by channel', () => {
    const funnel = computeFunnel({ applications, events, now: '2027-01-01T00:00:00Z' })
    const official = funnel.byChannel.find((c) => c.channel === '官网')
    assert.equal(official.submitted, 2)
    assert.equal(official.interviews, 2)
    assert.equal(official.offers, 1)
    assert.equal(official.offerRate, 50)
  })

  it('warns that tiny samples are not actionable', () => {
    const funnel = computeFunnel({ applications, events, now: '2027-01-01T00:00:00Z' })
    assert.match(funnel.caveat, /样本只有 3 条/)
  })

  it('flags applications stalled 14+ days in early stages', () => {
    const old = [{ id: 'z1', company_name: '慢公司', channel: '官网', status: 'applied', applied_at: '2026-09-01', created_at: '2026-09-01' }]
    const funnel = computeFunnel({ applications: old, events: [], now: '2026-10-01T00:00:00Z' })
    assert.equal(funnel.stalled.length, 1)
    assert.equal(funnel.stalled[0].days, 30)
  })

  it('handles an empty pipeline without inventing numbers', () => {
    const funnel = computeFunnel({ applications: [], events: [], now: '2027-01-01T00:00:00Z' })
    assert.equal(funnel.submitted, 0)
    assert.equal(funnel.choke, null)
    assert.ok(funnel.stages.every((s) => s.count === 0 && s.passRate === null))
  })
})

describe('submission proof', () => {
  const job = {
    id: 'j1', title: '产品经理实习生', company_name: '字节跳动', location: '北京',
    deadline: '2027-03-01', apply_url: 'https://example.com/apply', recruit_type: 'summer',
    description: '负责 AI 产品规划', requirements: '硕士在读', skills: '["SQL","Python"]',
  }

  it('freezes the JD from the job row so it survives later syncs', () => {
    const jd = freezeJd({ job })
    assert.equal(jd.source, 'job')
    assert.equal(jd.title, '产品经理实习生')
    assert.equal(jd.description, '负责 AI 产品规划')
    assert.deepEqual(jd.skills, ['SQL', 'Python'])
    assert.ok(jd.capturedAt)
  })

  it('prefers a pasted JD over the job row', () => {
    const jd = freezeJd({ job, jd: '原始 JD 正文' })
    assert.equal(jd.source, 'user')
    assert.equal(jd.text, '原始 JD 正文')
  })

  it('records it honestly when no materials were specified', () => {
    const snapshot = buildSubmissionSnapshot({ resumeVersion: { id: 'v1', label: '产品版' }, documents: [] })
    assert.equal(snapshot.resumeLabel, '产品版')
    assert.equal(snapshot.materialsSpecified, false)
    assert.match(snapshot.note, /没有指定提交材料/)
  })

  it('stores JD and snapshot on the application record', () => {
    const env = makeEnv()
    try {
      const resume = env.repos.profile.addResume({ label: '产品版', rawText: '内容', sourceType: 'upload' })
      const doc = env.repos.profile.addDocument({ fileName: 'TOEFL.pdf', category: 'language', title: 'TOEFL 105' })
      const app = env.repos.applications.create({
        companyName: '字节跳动', jobTitle: '产品经理实习生', jd: '原始 JD', jdUrl: 'https://example.com/jd',
        resumeVersionId: resume.id, docIds: [doc.id], channel: '官网',
      })
      assert.equal(app.submittedJd.source, 'user')
      assert.equal(app.submittedJd.text, '原始 JD')
      assert.equal(app.submissionSnapshot.resumeVersionId, resume.id)
      assert.equal(app.submissionSnapshot.materialsSpecified, true)
      assert.equal(app.submissionSnapshot.documents.length, 1)
      assert.equal(app.jd_url, 'https://example.com/jd')
    } finally {
      env.cleanup()
    }
  })

  it('detects a repeat application to the same company within the cooldown window', () => {
    const env = makeEnv()
    try {
      env.repos.applications.create({ companyName: '字节跳动', jobTitle: '产品经理', status: 'applied', appliedAt: '2026-11-01' })
      const hit = env.repos.applications.cooldownCheck({ companyName: '字节' })
      assert.equal(hit.blocked, true)
      const miss = env.repos.applications.cooldownCheck({ companyName: '腾讯' })
      assert.equal(miss.blocked, false)
    } finally {
      env.cleanup()
    }
  })

  it('exposes the funnel from stored history', () => {
    const env = makeEnv()
    try {
      const app = env.repos.applications.create({ companyName: '字节', jobTitle: 'PM', status: 'applied' })
      env.repos.applications.update(app.id, { status: 'assessment' })
      env.repos.applications.update(app.id, { status: 'interview_1' })
      const funnel = env.repos.applications.funnel()
      assert.equal(funnel.submitted, 1)
      assert.equal(funnel.stages.find((s) => s.key === 'interview_1').count, 1)
      assert.equal(funnel.stages.find((s) => s.key === 'offer').count, 0)
    } finally {
      env.cleanup()
    }
  })
})
