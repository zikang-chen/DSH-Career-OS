// 简历质量检查：只报可核对的问题，不生成内容、不推断。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkResumeQuality, parsePeriod } from '../host/quality.js'

const baseProfile = {
  display_name: '陈同学', school: '东南大学', degree: '硕士', major: '计算机技术', grad_year: 2028,
  phone: '13800000000', email: 'me@example.com',
  skills: [{ name: 'Python' }, { name: 'SQL' }],
}
const edu = { id: 'e1', kind: 'education', organization: '东南大学', role: '硕士', start_at: '2025-09', end_at: '2028-06', bullets: ['研究方向：边缘计算'], verified: true }
const work = { id: 'w1', kind: 'activity', organization: '闲鱼', role: '运营', start_at: '2021-09', end_at: '2024-10', bullets: ['累计 47 万元交易流水', '用 Python 做数据分析'], verified: true }

describe('period parsing', () => {
  it('parses YYYY-MM and YYYY年M月', () => {
    assert.deepEqual(parsePeriod('2025-09'), { year: 2025, month: 9 })
    assert.deepEqual(parsePeriod('2024年10月'), { year: 2024, month: 10 })
    assert.deepEqual(parsePeriod('2021'), { year: 2021, month: null })
  })
  it('returns null for junk', () => {
    assert.equal(parsePeriod('abc'), null)
    assert.equal(parsePeriod(''), null)
  })
})

describe('resume quality', () => {
  it('passes a clean resume with no errors', () => {
    const result = checkResumeQuality({ profile: baseProfile, experiences: [edu, work], documents: [] })
    assert.equal(result.summary.error, 0)
    assert.equal(result.ok, true)
  })

  it('flags missing phone/email as errors', () => {
    const result = checkResumeQuality({ profile: { ...baseProfile, phone: '', email: '' }, experiences: [edu] })
    assert.equal(result.summary.error, 2)
    assert.ok(result.issues.some((i) => i.code === 'missing-phone'))
    assert.ok(result.issues.some((i) => i.code === 'missing-email'))
    assert.equal(result.ok, false)
  })

  it('flags missing education and education without dates', () => {
    const noEdu = checkResumeQuality({ profile: baseProfile, experiences: [work] })
    assert.ok(noEdu.issues.some((i) => i.code === 'missing-education'))
    const noDates = checkResumeQuality({ profile: baseProfile, experiences: [{ ...edu, start_at: '', end_at: '' }] })
    assert.ok(noDates.issues.some((i) => i.code === 'education-missing-date'))
  })

  it('flags inverted dates instead of silently accepting them', () => {
    const bad = { ...work, start_at: '2024-01', end_at: '2022-01' }
    const result = checkResumeQuality({ profile: baseProfile, experiences: [edu, bad] })
    assert.ok(result.issues.some((i) => i.code === 'date-inverted'))
  })

  it('flags duplicate organization entries', () => {
    const dup = { ...work, id: 'w2' }
    const result = checkResumeQuality({ profile: baseProfile, experiences: [edu, work, dup] })
    assert.ok(result.issues.some((i) => i.code === 'duplicate-organization'))
  })

  it('reports skills with no supporting evidence', () => {
    const result = checkResumeQuality({ profile: { ...baseProfile, skills: [{ name: 'Python' }, { name: 'Rust' }] }, experiences: [edu, work] })
    const issue = result.issues.find((i) => i.code === 'skill-without-evidence')
    assert.ok(issue)
    assert.match(issue.message, /Rust/)
    assert.ok(!issue.message.includes('Python'), 'Python appears in bullets, should not be flagged')
  })

  it('checks JD coverage when a job is given, and says JD is incomplete', () => {
    const result = checkResumeQuality({
      profile: baseProfile, experiences: [edu, work],
      job: { id: 'j1', title: '产品经理', description: '', requirements: '', skills: ['Python', 'Figma'] },
    })
    assert.ok(result.issues.some((i) => i.code === 'jd-incomplete'), 'empty JD must be flagged')
    const gap = result.issues.find((i) => i.code === 'jd-gap')
    assert.ok(gap)
    assert.match(gap.message, /Figma/)
    assert.ok(!gap.message.includes('Python'))
  })

  it('never invents content — only reports', () => {
    const result = checkResumeQuality({ profile: {}, experiences: [] })
    const text = JSON.stringify(result)
    assert.ok(!/建议补充|已为你|生成/.test(text))
    assert.ok(result.issues.length > 0)
  })
})
