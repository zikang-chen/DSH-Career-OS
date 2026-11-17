// JD → 面试问题/知识点分析。全部离线。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildInterviewPlan, buildResearchQueries, extractJdFacts, extractTopics, mergeResearchQuestions } from '../host/interview.js'

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

describe('broad research aggregation', () => {
  it('dedupes the same question across sources and counts sources', () => {
    const experiences = [{ questions: ['你怎么做需求优先级？', '讲讲你的项目'], evidence_level: 'C', source_url: 'https://bbs/a' }]
    const research = [
      { source: '牛客', url: 'https://nowcoder/1', publishedAt: '2025-09', questions: ['你怎么做需求优先级？', 'AB 测试怎么设计'] },
      { source: '知乎', url: 'https://zhihu/2', publishedAt: '2025-10', questions: ['你怎么做需求优先级？'] },
    ]
    const merged = mergeResearchQuestions({ experiences, research })
    const top = merged[0]
    assert.equal(top.question, '你怎么做需求优先级？')
    assert.equal(top.seenCount, 3, 'three independent sources mention it')
    assert.ok(merged.some((m) => m.question === 'AB 测试怎么设计' && m.seenCount === 1))
  })

  it('separates imported vs external sources with evidence level', () => {
    const merged = mergeResearchQuestions({
      experiences: [{ questions: ['项目难点？'], evidence_level: 'C' }],
      research: [{ source: '牛客', url: 'https://x', questions: ['项目难点？'], evidenceLevel: 'D' }],
    })
    const q = merged.find((m) => m.question === '项目难点？')
    assert.equal(q.seenCount, 2)
    assert.ok(q.sources.some((s) => s.kind === 'imported-forum'))
    assert.ok(q.sources.some((s) => s.kind === 'external-research'))
  })

  it('plan includes researchedQuestions + a research plan of where to look', () => {
    const plan = buildInterviewPlan({
      jdText: PRODUCT_JD, company: '腾讯', title: 'AI 产品经理',
      research: [{ source: '牛客', url: 'https://nowcoder/1', questions: ['你怎么做需求优先级？'] }],
    })
    assert.equal(plan.researchedQuestions.length, 1)
    assert.ok(plan.researchPlan.length >= 4)
    assert.ok(plan.researchPlan.some((r) => r.query.includes('腾讯')))
    assert.ok(plan.caveats.some((c) => c.includes('多来源调研')))
  })

  it('research queries target the right platforms', () => {
    const plan = buildResearchQueries({ company: '字节跳动', role: '产品经理' })
    const platforms = plan.map((p) => p.platform)
    assert.ok(platforms.includes('牛客网') && platforms.includes('知乎'))
    assert.ok(plan.every((p) => p.query.length > 0 && p.why))
  })
})
