// JD → 面试问题/知识点分析。全部离线。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildInterviewPlan, extractJdFacts, extractTopics } from '../host/interview.js'

const PRODUCT_JD = `岗位职责：
1、负责 AI 产品的需求分析与 PRD 撰写，搭建指标体系；
2、跟进用户研究，做竞品分析，推动跨团队协作。
任职要求：
1、本科及以上，每周出勤 4 天；
2、熟悉 SQL 与数据分析，了解 AB 测试；
3、对大模型与 RAG 有基础认知。工作地点：北京/上海。`

describe('topic extraction', () => {
  it('matches knowledge topics from real JD keywords', () => {
    const topics = extractTopics(PRODUCT_JD).map((t) => t.key)
    assert.ok(topics.includes('product'))
    assert.ok(topics.includes('sql'))
    assert.ok(topics.includes('data'))
    assert.ok(topics.includes('llm'))
    assert.ok(topics.includes('rag'))
  })

  it('returns nothing for text with no known direction', () => {
    assert.deepEqual(extractTopics('我们招一个热情的人，待遇面议。'), [])
  })

  it('extracts hard facts (years/degree/cities/days)', () => {
    const facts = extractJdFacts(PRODUCT_JD)
    assert.equal(facts.degree, '本科')
    assert.equal(facts.daysPerWeek, 4)
    assert.ok(facts.cities.includes('北京') && facts.cities.includes('上海'))
    assert.equal(extractJdFacts('3年以上相关经验').experienceYears, 3)
  })
})

describe('interview plan', () => {
  it('produces practice questions, all labelled ai-practice, never as real', () => {
    const plan = buildInterviewPlan({ jdText: PRODUCT_JD, title: 'AI 产品经理', company: '腾讯' })
    assert.equal(plan.ok, true)
    assert.ok(plan.questions.length > 0)
    assert.ok(plan.questions.every((q) => q.source === 'ai-practice'), 'every generated question must be labelled ai-practice')
    assert.ok(plan.caveats.some((c) => c.includes('不是真实面试题')))
    assert.ok(plan.knowledgePoints.length >= 3)
  })

  it('keeps imported forum questions separate with their evidence level', () => {
    const real = [{ questions: ['你们项目里指标怎么定的？'], evidence_level: 'C', stage: '一面', year: 2025 }]
    const plan = buildInterviewPlan({ jdText: PRODUCT_JD, realExperiences: real })
    assert.equal(plan.realQuestions.length, 1)
    assert.equal(plan.realQuestions[0].source, 'imported-forum')
    assert.equal(plan.realQuestions[0].evidenceLevel, 'C')
    assert.ok(plan.counts.realQuestions === 1)
    // 生成的练习题里不能混入真实面经
    assert.ok(plan.questions.every((q) => q.source === 'ai-practice'))
  })

  it('refuses an empty JD instead of inventing questions', () => {
    const plan = buildInterviewPlan({ jdText: '   ' })
    assert.equal(plan.ok, false)
    assert.match(plan.error, /没有 JD/)
  })

  it('admits when the JD hits no known direction', () => {
    const plan = buildInterviewPlan({ jdText: '招一个热情的人，待遇面议。' })
    assert.equal(plan.questions.length, 0)
    assert.ok(plan.caveats.some((c) => c.includes('没有命中')))
  })
})
