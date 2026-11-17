// 个人资料库：分类、分数抽取、按岗位筛选、简历渲染。全部离线断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DOC_LABEL,
  classifyDocument,
  documentLine,
  extractScore,
  planDocumentSelection,
  proposeDocument,
  renderDocumentLines,
  scoreDocumentForJob,
  titleFromFileName,
} from '../host/documents.js'
import { makeEnv } from './helpers.mjs'

describe('document classification', () => {
  it('recognises the common proof types', () => {
    assert.equal(classifyDocument({ fileName: 'TOEFL成绩单.pdf' }), 'language')
    assert.equal(classifyDocument({ fileName: 'CET-6证书.jpg' }), 'language')
    assert.equal(classifyDocument({ fileName: '发明专利证书.pdf' }), 'patent')
    assert.equal(classifyDocument({ fileName: '学位证.pdf' }), 'degree')
    assert.equal(classifyDocument({ fileName: '本科成绩单.pdf' }), 'transcript')
    assert.equal(classifyDocument({ fileName: '奖学金证书.pdf' }), 'award')
    assert.equal(classifyDocument({ fileName: 'ELVIS论文.pdf' }), 'publication')
    assert.equal(classifyDocument({ fileName: '随便一个文件.pdf', text: '无关键字' }), 'other')
  })

  it('falls back to body text when the filename says nothing', () => {
    assert.equal(classifyDocument({ fileName: 'scan_001.pdf', text: '本证书证明该同学通过大学英语六级考试' }), 'language')
  })
})

describe('score extraction', () => {
  it('pulls TOEFL / IELTS / CET / GPA without inventing', () => {
    assert.deepEqual(extractScore('TOEFL 105 (R30 L28 S22 W25)'), { score: 'TOEFL 105', value: 105, unit: '分', kind: 'TOEFL' })
    assert.equal(extractScore('雅思 7.5').value, 7.5)
    assert.equal(extractScore('CET-6 527').score, 'CET-6 527')
    assert.equal(extractScore('CET-4 627').value, 627)
    assert.equal(extractScore('GPA 3.72/4.0').value, 3.72)
    assert.equal(extractScore('没有任何分数'), null)
  })

  it('depends on numbers actually being present', () => {
    assert.equal(extractScore('托福成绩单'), null)
  })
})

describe('document proposal', () => {
  it('proposes fields and always asks for confirmation', () => {
    const proposal = proposeDocument({ fileName: 'TOEFL_score_report.pdf', text: 'TOEFL 105' })
    assert.equal(proposal.category, 'language')
    assert.equal(proposal.categoryLabel, DOC_LABEL.language)
    assert.equal(proposal.score, 'TOEFL 105')
    assert.equal(proposal.scoreValue, 105)
    assert.equal(proposal.requiresConfirmation, true)
    assert.match(proposal.hint, /核对/)
  })

  it('derives a readable title from the filename', () => {
    assert.equal(titleFromFileName('陈子康_TOEFL成绩单.pdf'), '陈子康 TOEFL成绩单')
    assert.equal(titleFromFileName(''), '未命名资料')
  })
})

describe('job-aware selection', () => {
  const docs = [
    { id: 'l1', category: 'language', title: 'TOEFL', score: 'TOEFL 105', score_value: 105, verified: true },
    { id: 'p1', category: 'publication', title: 'Electronics 2024', verified: true },
    { id: 'a1', category: 'award', title: '校奖学金', verified: false },
  ]

  it('rates language proof higher for a job that asks for English', () => {
    const englishJob = { title: '海外产品经理', description: '要求英语流利，能对接海外团队', requirements: '', skills: [] }
    const cnJob = { title: '产品经理', description: '负责国内需求分析', requirements: '', skills: [] }
    const withEn = scoreDocumentForJob(docs[0], englishJob)
    const withoutEn = scoreDocumentForJob(docs[0], cnJob)
    assert.ok(withEn.score > withoutEn.score, `${withEn.score} should beat ${withoutEn.score}`)
    assert.ok(withEn.reasons.some((r) => r.includes('语言')))
  })

  it('rates research output higher for a research-heavy job', () => {
    const researchJob = { title: '算法研究员', description: '需要发表过论文，有 CCF 或 SCI 优先', requirements: '', skills: [] }
    const pmJob = { title: '产品经理', description: '需求分析、原型设计', requirements: '', skills: [] }
    assert.ok(scoreDocumentForJob(docs[1], researchJob).score > scoreDocumentForJob(docs[1], pmJob).score)
  })

  it('respects max and category filters', () => {
    const plan = planDocumentSelection({ documents: docs, job: { description: '英语' }, max: 1 })
    assert.equal(plan.selected.length, 1)
    const filtered = planDocumentSelection({ documents: docs, job: {}, categories: ['award'] })
    assert.equal(filtered.selected.length, 1)
    assert.equal(filtered.selected[0].category, 'award')
  })

  it('says the vault is empty instead of returning fake entries', () => {
    const plan = planDocumentSelection({ documents: [], job: {} })
    assert.equal(plan.selected.length, 0)
    assert.match(plan.note, /资料库为空/)
  })
})

describe('resume rendering of documents', () => {
  it('groups by category in CV order and dedupes identical lines', () => {
    const groups = renderDocumentLines([
      { category: 'award', title: '校奖学金', issued_at: '2024-10' },
      { category: 'language', title: 'TOEFL', score: 'TOEFL 105' },
      { category: 'language', title: 'TOEFL', score: 'TOEFL 105' },
      { category: 'patent', title: '发明专利', credential_id: 'CN123' },
    ])
    assert.deepEqual(groups.map((g) => g.category), ['language', 'patent', 'award'])
    assert.equal(groups[0].lines.length, 1, 'duplicate line collapses')
    assert.equal(groups[1].label, '专利')
  })

  it('builds one line per document without inventing fields', () => {
    assert.equal(documentLine({ category: 'language', score: 'TOEFL 105' }), 'TOEFL 105')
    const line = documentLine({ category: 'award', title: '一等奖', issuer: '全国大学生竞赛', issued_at: '2024-06' })
    assert.equal(line, '一等奖 · 全国大学生竞赛 · 2024-06')
  })
})

describe('document vault storage', () => {
  it('stores, filters, updates and deletes documents', () => {
    const env = makeEnv()
    try {
      const lang = env.repos.profile.addDocument({
        fileName: 'TOEFL.pdf', rawText: 'TOEFL 105', category: 'language', title: 'TOEFL',
        issuer: 'ETS', issuedAt: '2025-05', score: 'TOEFL 105', scoreValue: 105, scoreUnit: '分',
      })
      assert.equal(lang.category, 'language')
      assert.equal(lang.verified, false, 'nothing is trusted until confirmed')

      env.repos.profile.addDocument({ fileName: '专利证书.pdf', category: 'patent', title: '发明专利', credentialId: 'CN202311785715.8' })

      assert.equal(env.repos.profile.listDocuments().length, 2)
      assert.equal(env.repos.profile.listDocuments({ category: ['patent'] }).length, 1)
      assert.equal(env.repos.profile.listDocuments({ query: 'TOEFL' }).length, 1)
      assert.equal(env.repos.profile.listDocuments({ verified: true }).length, 0)

      const verified = env.repos.profile.updateDocument(lang.id, { verified: true, issuer: 'ETS (核对)' })
      assert.equal(verified.verified, true)
      assert.equal(env.repos.profile.listDocuments({ verified: true }).length, 1)

      const stats = env.repos.profile.documentStats()
      assert.equal(stats.total, 2)
      assert.equal(stats.verified, 1)

      assert.equal(env.repos.profile.deleteDocument(lang.id), true)
      assert.equal(env.repos.profile.listDocuments().length, 1)
    } finally {
      env.cleanup()
    }
  })

  it('infers the category when the caller does not supply one', () => {
    const env = makeEnv()
    try {
      const doc = env.repos.profile.addDocument({ fileName: 'CET-6成绩单.pdf', rawText: 'CET-6 527' })
      assert.equal(doc.category, 'language')
      assert.equal(doc.title, 'CET-6成绩单')
    } finally {
      env.cleanup()
    }
  })
})
