// 简历优化 skill：诊断逻辑（不编造）。离线。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RESUME_SKILLS, analyzeBullets } from '../host/resume_skills.js'
import { prepResumeForJob } from '../host/workflows.js'

describe('skill library', () => {
  it('ships the core methodologies with before/after examples', () => {
    const ids = RESUME_SKILLS.map((s) => s.id)
    for (const must of ['xyz', 'star', 'quantify', 'strong-verb', 'jd-align', 'translate', 'trim', 'gap-honesty']) {
      assert.ok(ids.includes(must), `missing skill ${must}`)
    }
    for (const s of RESUME_SKILLS) {
      assert.ok(s.name && s.when && s.how, `${s.id} incomplete`)
      assert.ok(s.example?.before && s.example?.after)
    }
  })
})

describe('bullet analysis', () => {
  it('flags missing metric, weak verb, and no result', () => {
    const r = analyzeBullets({ bullets: ['负责一些数据分析工作'] })
    const b = r.perBullet[0]
    assert.ok(b.issues.some((i) => i.includes('弱动词')))
    assert.ok(b.issues.some((i) => i.includes('缺量化')))
    assert.ok(b.skillIds.includes('strong-verb'))
    assert.ok(b.skillIds.includes('quantify'))
  })

  it('does not flag a well-formed quantified bullet', () => {
    const r = analyzeBullets({ bullets: ['用 SQL 做留存分析，定位 3 个流失点，使次留提升 6%'] })
    const b = r.perBullet[0]
    assert.ok(!b.skillIds.includes('quantify'))
    assert.ok(!b.skillIds.includes('strong-verb'))
    assert.ok(!b.skillIds.includes('xyz'))
  })

  it('flags overly long bullets for trimming', () => {
    const long = '主导了某某系统的设计与实现，' + '并协调多个团队完成上线与迭代优化。'.repeat(6)
    const r = analyzeBullets({ bullets: [long] })
    assert.ok(r.perBullet[0].skillIds.includes('trim'))
  })

  it('reports JD keyword coverage and missing keywords', () => {
    const r = analyzeBullets({ bullets: ['用 Python 做数据清洗'], jdText: '要求熟练 SQL、Python，懂 A/B 测试' })
    assert.ok(r.jdCoverage.keywords.includes('Python'))
    assert.ok(r.jdCoverage.covered.includes('Python'))
    assert.ok(r.jdCoverage.missing.some((k) => /sql/i.test(k)) || r.jdCoverage.missing.length >= 1)
    assert.match(r.jdCoverage.note, /覆盖|缺/)
  })

  it('never invents achievements — only issues/skill ids', () => {
    const r = analyzeBullets({ bullets: ['参与了项目'] })
    const text = JSON.stringify(r.perBullet)
    assert.ok(!/\d+%|万|提升到/.test(text), 'must not fabricate numbers')
    assert.ok(r.caveats.some((c) => c.includes('不替你新造')))
  })

  it('handles empty JD and empty bullets honestly', () => {
    const r = analyzeBullets({ bullets: [], jdText: '' })
    assert.equal(r.summary.bullets, 0)
    assert.match(r.jdCoverage.note, /没提供 JD/)
  })
})

describe('prep resume includes skill advice', () => {
  it('attaches skillAdvice with summary and jd coverage', () => {
    const profile = { grad_year: 2028, cities: ['北京'], weekly_days: 4, skills: [{ name: 'Python' }] }
    const experiences = [
      { id: 'e1', kind: 'education', organization: '东南大学', role: '硕士', start_at: '2025-09', end_at: '2028-06', bullets: ['计算机技术'], skills: [] },
      { id: 'a1', kind: 'activity', organization: '闲鱼', role: '运营', start_at: '2021-09', end_at: '2024-10', bullets: ['负责店铺运营', '累计 47 万流水'], skills: [] },
    ]
    const job = { id: 'j1', company_name: '腾讯', title: '产品经理', description: '负责产品需求，需 SQL', requirements: '本科', skills: ['SQL'] }
    const r = prepResumeForJob({ profile, experiences, documents: [], job })
    assert.ok(r.skillAdvice)
    assert.ok(r.skillAdvice.summary.bullets >= 1)
    assert.ok(Array.isArray(r.skillAdvice.skills))
    assert.ok(r.skillAdvice.jdCoverage.keywords.length >= 1)
  })
})
