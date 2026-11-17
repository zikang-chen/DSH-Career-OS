// 首次真实投递才冻结最终材料：只使用临时数据库，不读个人库或浏览器。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { buildSubmissionSnapshot, submissionContentHash } from '../host/submission.js'
import { makeEnv } from './helpers.mjs'

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const envFor = (t) => { const env = makeEnv(); t.after(() => env.cleanup()); return env }
const makeResume = (env, label = '初稿', rawText = '真实的原始简历内容') => env.repos.profile.addResume({ label, rawText, texSource: `\\documentclass{article}\n${rawText}`, parsed: { skills: ['SQL'] }, targetRole: '产品', sourceType: 'paste' })
const makeDoc = (env, title = '语言成绩', score = 'TOEFL 105') => env.repos.profile.addDocument({ title, category: 'language', issuer: '考试机构', rawText: `真实成绩单原文：${score}`, score, credentialId: 'TEST-CREDENTIAL', issuedAt: '2026-01', tags: ['语言'], verified: true })
const createDraft = (env, input = {}) => env.repos.applications.create({ companyName: '测试公司', jobTitle: '产品实习', status: 'ready', ...input })
const stored = (env, id) => env.db.get('SELECT * FROM application WHERE id = ?', [id])

describe('submission content snapshots', () => {
  it('copies raw/tex/document facts, hashes their actual contents, and detaches input objects', () => {
    const resume = { id: 'r1', label: '最终版', raw_text: '真实原文\n不能改写', tex_source: '\\section{真实内容}', parsed: { skills: ['SQL'] }, language: 'zh', source_type: 'latex' }
    const document = { id: 'd1', title: '成绩单', category: 'language', raw_text: 'TOEFL 105', score: '105', issuer: 'ETS', credential_id: 'id-1', verified: 1, tags: ['原始标签'] }
    const snapshot = buildSubmissionSnapshot({ resumeVersion: resume, documents: [document], specified: true, state: 'submitted', capturedAt: '2026-11-17T00:00:00Z' })
    assert.equal(snapshot.version, 2)
    assert.equal(snapshot.frozen, true)
    assert.equal(snapshot.frozenAt, snapshot.capturedAt)
    assert.equal(snapshot.resume.rawText, resume.raw_text)
    assert.equal(snapshot.resume.texSource, resume.tex_source)
    assert.equal(snapshot.resume.rawTextHash, hash(resume.raw_text))
    assert.equal(snapshot.resume.texSourceHash, hash(resume.tex_source))
    assert.equal(snapshot.documents[0].rawText, document.raw_text)
    assert.equal(snapshot.documents[0].rawTextHash, hash(document.raw_text))
    assert.equal(snapshot.documents[0].issuer, 'ETS')
    assert.equal(snapshot.documents[0].credentialId, 'id-1')
    assert.equal(snapshot.documents[0].verified, true)
    assert.equal(snapshot.hash, submissionContentHash({ resume: snapshot.resume, documents: snapshot.documents, materialsSpecified: true }))
    resume.parsed.skills.push('事后修改')
    document.tags.push('事后标签')
    assert.deepEqual(snapshot.resume.parsed.skills, ['SQL'])
    assert.deepEqual(snapshot.documents[0].tags, ['原始标签'])
    assert.equal(snapshot.contentScope, 'database-text-and-metadata', 'does not claim to archive binary attachments')
  })

  it('keeps missing contents explicit and never invents a resume or raw text', () => {
    const empty = buildSubmissionSnapshot()
    assert.equal(empty.state, 'draft')
    assert.equal(empty.resume, null)
    assert.equal(empty.resumeVersionId, null)
    assert.deepEqual(empty.documents, [])
    assert.equal(empty.materialsSpecified, false)
    const metadataOnly = buildSubmissionSnapshot({ resumeVersion: { id: 'r1', label: '仅文件元数据' }, specified: true })
    assert.equal(metadataOnly.resume.rawText, null)
    assert.equal(metadataOnly.resume.texSource, null)
    assert.equal(metadataOnly.resume.contentAvailable, false)
    assert.equal(metadataOnly.warnings.length, 1)
  })
})

describe('application first-submission freeze', () => {
  it('refreshes saved/ready drafts, including edits to the same resume id, without editing source facts', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    const doc = makeDoc(env)
    const app = createDraft(env, { status: 'saved', resumeVersionId: resume.id, docIds: [doc.id] })
    assert.equal(app.submissionSnapshot.frozen, false)
    env.db.run('UPDATE resume_version SET raw_text = ?, tex_source = ? WHERE id = ?', ['同一版本的最新原文', '最新真实 TeX', resume.id])
    env.db.run('UPDATE personal_document SET raw_text = ?, score = ? WHERE id = ?', ['最新成绩单原文', 'TOEFL 110', doc.id])
    const sourceBefore = env.db.get('SELECT * FROM resume_version WHERE id = ?', [resume.id])
    const refreshed = env.repos.applications.update(app.id, {})
    assert.equal(refreshed.submissionSnapshot.state, 'draft')
    assert.equal(refreshed.submissionSnapshot.resume.rawText, '同一版本的最新原文')
    assert.equal(refreshed.submissionSnapshot.resume.texSource, '最新真实 TeX')
    assert.equal(refreshed.submissionSnapshot.documents[0].score, 'TOEFL 110')
    assert.notEqual(refreshed.submissionSnapshot.hash, app.submissionSnapshot.hash)
    assert.deepEqual(env.db.get('SELECT * FROM resume_version WHERE id = ?', [resume.id]), sourceBefore)
    assert.equal(refreshed.events.filter((event) => event.type === 'submission_frozen').length, 0)
  })

  it('switches draft materials and freezes the final contents atomically on ready -> applied', (t) => {
    const env = envFor(t)
    const first = makeResume(env)
    const final = makeResume(env, '最终版', '最终提交的简历原文')
    const oldDoc = makeDoc(env, '旧成绩')
    const finalDoc = makeDoc(env, '最终成绩', 'TOEFL 110')
    const app = createDraft(env, { resumeVersionId: first.id, docIds: [oldDoc.id] })
    const switched = env.repos.applications.update(app.id, { resumeVersionId: final.id, docIds: [finalDoc.id], snapshotNote: '最终提交包' })
    assert.equal(switched.submissionSnapshot.resumeVersionId, final.id)
    assert.equal(switched.submissionSnapshot.resume.rawText, '最终提交的简历原文')
    env.db.run('UPDATE resume_version SET raw_text = ? WHERE id = ?', ['投递瞬间最新原文', final.id])
    env.repos.profile.updateDocument(finalDoc.id, { score: 'TOEFL 112' })
    const readDepths = []
    const get = env.db.get.bind(env.db)
    env.db.get = (sql, params) => { if (/SELECT \* FROM (resume_version|personal_document)/.test(sql)) readDepths.push(env.db.depth); return get(sql, params) }
    const submitted = env.repos.applications.update(app.id, { status: 'applied' })
    assert.ok(readDepths.length >= 2 && readDepths.every((depth) => depth > 0), 'material reads happen in the write transaction')
    assert.equal(submitted.submissionSnapshot.state, 'submitted')
    assert.equal(submitted.submissionSnapshot.frozen, true)
    assert.equal(submitted.submissionSnapshot.resume.rawText, '投递瞬间最新原文')
    assert.equal(submitted.submissionSnapshot.documents[0].score, 'TOEFL 112')
    assert.equal(submitted.submissionSnapshot.note, '最终提交包')
    assert.ok(submitted.applied_at)
    const event = submitted.events.find((item) => item.type === 'submission_frozen')
    assert.equal(JSON.parse(event.note).hash, submitted.submissionSnapshot.hash)
  })

  it('allows resumeVersionId/docIds to change in the same patch that first submits', (t) => {
    const env = envFor(t)
    const first = makeResume(env)
    const final = makeResume(env, '最终版', '同一投递操作指定的最终简历')
    const doc = makeDoc(env)
    const app = createDraft(env, { resumeVersionId: first.id })
    const result = env.repos.applications.update(app.id, { status: 'applied', resumeVersionId: final.id, docIds: [doc.id] })
    assert.equal(result.resume_version_id, final.id)
    assert.equal(result.submissionSnapshot.resumeVersionId, final.id)
    assert.equal(result.submissionSnapshot.resume.rawText, final.raw_text)
    assert.equal(result.submissionSnapshot.documents[0].rawText, doc.raw_text)
  })

  it('freezes direct advanced-stage creation or transitions, and records an applied date', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    for (const status of ['applied', 'assessment', 'written_test', 'interview_1', 'interview_2', 'final', 'hr', 'offer']) {
      const app = createDraft(env, { status, resumeVersionId: resume.id })
      assert.equal(app.submissionSnapshot.frozen, true, status)
      assert.ok(app.applied_at, status)
      assert.equal(app.events.filter((event) => event.type === 'submission_frozen').length, 1, status)
    }
    const draft = createDraft(env, { resumeVersionId: resume.id })
    const interview = env.repos.applications.update(draft.id, { status: 'interview_1' })
    assert.equal(interview.submissionSnapshot.frozen, true)
    assert.ok(interview.applied_at)
    assert.equal(env.repos.applications.funnel().submitted, 9)
  })

  it('does not infer a submission from a closed/withdrawn/rejected draft without evidence', (t) => {
    const env = envFor(t)
    for (const status of ['closed', 'withdrawn', 'rejected']) {
      const app = createDraft(env, { status })
      assert.equal(app.submissionSnapshot.frozen, false)
      assert.equal(app.applied_at, null)
    }
    const app = createDraft(env)
    const submitted = env.repos.applications.update(app.id, { appliedAt: '2026-11-10' })
    assert.equal(submitted.submissionSnapshot.frozen, true, 'an explicit applied date is submission evidence')
    assert.equal(submitted.applied_at, '2026-11-10')
  })

  it('keeps final raw/tex/doc/JD contents after original material deletion and further status updates', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    const doc = makeDoc(env)
    const app = createDraft(env, { status: 'applied', resumeVersionId: resume.id, docIds: [doc.id], jd: '当时真实投递要求' })
    const before = stored(env, app.id)
    env.repos.profile.deleteResume(resume.id)
    env.repos.profile.deleteDocument(doc.id)
    const updated = env.repos.applications.update(app.id, { status: 'interview_1', resumeVersionId: resume.id, notes: '继续跟进' })
    assert.equal(stored(env, app.id).submission_snapshot, before.submission_snapshot)
    assert.equal(stored(env, app.id).submitted_jd, before.submitted_jd)
    assert.equal(updated.submissionSnapshot.resume.rawText, resume.raw_text)
    assert.equal(updated.submissionSnapshot.resume.texSource, resume.tex_source)
    assert.equal(updated.submissionSnapshot.documents[0].rawText, doc.raw_text)
    assert.equal(updated.submittedJd.text, '当时真实投递要求')
    assert.equal(updated.events.filter((event) => event.type === 'submission_frozen').length, 1)
  })

  it('rejects changes to submitted materials with no partial status/note write, even after a rewind', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    const another = makeResume(env, '另一版')
    const doc = makeDoc(env)
    const app = createDraft(env, { status: 'applied', resumeVersionId: resume.id, docIds: [doc.id] })
    const before = stored(env, app.id)
    for (const patch of [{ resumeVersionId: another.id }, { resumeVersionId: null }, { docIds: [] }, { snapshotNote: '覆盖历史' }, { jd: '新JD' }]) {
      assert.throws(() => env.repos.applications.update(app.id, { status: 'offer', notes: '不能部分保存', ...patch }), /已经正式投递/)
      assert.deepEqual(stored(env, app.id), before)
    }
    env.repos.applications.update(app.id, { status: 'saved', appliedAt: null })
    assert.throws(() => env.repos.applications.update(app.id, { resumeVersionId: another.id }), /已经正式投递/)
    assert.equal(stored(env, app.id).submission_snapshot, before.submission_snapshot)
  })

  it('rolls back snapshot/status/date/timeline together if the freeze event cannot be saved', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    const app = createDraft(env, { resumeVersionId: resume.id })
    const before = stored(env, app.id)
    const beforeEvents = env.repos.applications.get(app.id).events.length
    const run = env.db.run.bind(env.db)
    env.db.run = (sql, params) => {
      if (/INSERT INTO application_event/.test(sql) && params[2] === 'submission_frozen') throw new Error('freeze event failure')
      return run(sql, params)
    }
    assert.throws(() => env.repos.applications.update(app.id, { status: 'applied' }), /freeze event failure/)
    assert.deepEqual(stored(env, app.id), before)
    assert.equal(env.repos.applications.get(app.id).events.length, beforeEvents)
  })

  it('rejects missing selected records instead of silently omitting them, atomically', (t) => {
    const env = envFor(t)
    assert.throws(() => createDraft(env, { status: 'applied', resumeVersionId: 'missing' }), /简历版本不存在/)
    assert.equal(env.repos.applications.stats().total, 0)
    const resume = makeResume(env)
    const doc = makeDoc(env)
    const app = createDraft(env, { resumeVersionId: resume.id, docIds: [doc.id] })
    const before = stored(env, app.id)
    env.repos.profile.deleteDocument(doc.id)
    assert.throws(() => env.repos.applications.update(app.id, { status: 'applied' }), /资料不存在/)
    assert.deepEqual(stored(env, app.id), before)
  })

  it('never auto-selects the active resume when materials were not specified', (t) => {
    const env = envFor(t)
    makeResume(env, '不代表已提交的激活版本')
    const app = createDraft(env, { status: 'applied' })
    assert.equal(app.submissionSnapshot.resume, null)
    assert.equal(app.submissionSnapshot.resumeVersionId, null)
    assert.equal(app.submissionSnapshot.materialsSpecified, false)
    assert.match(app.submissionSnapshot.note, /没有指定提交材料/)
    const draft = createDraft(env)
    const resume = makeResume(env, '后续明确选择')
    const selected = env.repos.applications.update(draft.id, { resumeVersionId: resume.id })
    assert.equal(selected.submissionSnapshot.materialsSpecified, true)
    assert.equal(selected.submissionSnapshot.note, null, 'do not retain the default no-materials disclaimer after explicit selection')
  })

  it('distinguishes unspecified materials from an explicitly empty selection and inherits that choice', (t) => {
    const env = envFor(t)
    const unspecified = createDraft(env)
    assert.equal(unspecified.submissionSnapshot.materialsSpecified, false)
    assert.equal(env.repos.applications.update(unspecified.id, {}).submissionSnapshot.materialsSpecified, false)
    for (const input of [{ docIds: [] }, { resumeVersionId: null }, { resumeVersionId: null, docIds: [] }]) {
      const explicit = createDraft(env, input)
      assert.equal(explicit.submissionSnapshot.materialsSpecified, true)
      assert.equal(explicit.submissionSnapshot.resume, null)
      assert.deepEqual(explicit.submissionSnapshot.documents, [])
      assert.equal(explicit.submissionSnapshot.note, null, 'an explicit empty selection is not an unspecified-materials warning')
      assert.equal(env.repos.applications.update(explicit.id, {}).submissionSnapshot.materialsSpecified, true)
      assert.equal(env.repos.applications.update(explicit.id, { status: 'applied' }).submissionSnapshot.materialsSpecified, true)
    }
    const confirmedEmpty = env.repos.applications.update(unspecified.id, { docIds: [] })
    assert.equal(confirmedEmpty.submissionSnapshot.materialsSpecified, true)
    assert.equal(confirmedEmpty.submissionSnapshot.note, null)
    assert.equal(env.repos.applications.update(unspecified.id, { notes: '后续修改不丢确认状态' }).submissionSnapshot.materialsSpecified, true)
    const resume = makeResume(env)
    const selected = createDraft(env, { resumeVersionId: resume.id })
    const cleared = env.repos.applications.update(selected.id, { resumeVersionId: null, docIds: [] })
    assert.equal(cleared.submissionSnapshot.materialsSpecified, true)
    assert.equal(cleared.submissionSnapshot.resume, null)
  })

  it('refreshes job-derived draft JD at first submission but preserves an explicit pasted JD', (t) => {
    const env = envFor(t)
    const job = env.repos.jobs.upsertJob({ company: '岗位测试公司', title: '数据实习', description: '收藏时职责', requirements: '收藏时要求' })
    const draft = env.repos.applications.create({ jobId: job.id, status: 'ready' })
    const pasted = env.repos.applications.create({ jobId: job.id, status: 'ready', jd: '用户确认的原始 JD' })
    env.db.run('UPDATE job SET description = ?, requirements = ? WHERE id = ?', ['正式提交时职责', '正式提交时要求', job.id])
    const submitted = env.repos.applications.update(draft.id, { status: 'applied' })
    assert.equal(submitted.submittedJd.description, '正式提交时职责')
    assert.equal(submitted.submittedJd.requirements, '正式提交时要求')
    assert.equal(env.repos.applications.update(pasted.id, { status: 'applied' }).submittedJd.text, '用户确认的原始 JD')
    env.db.run('UPDATE job SET description = ? WHERE id = ?', ['提交后改动', job.id])
    assert.equal(env.repos.applications.update(submitted.id, { status: 'assessment' }).submittedJd.description, '正式提交时职责')
  })

  it('upgrades an old draft on first submit but never fabricates missing content for legacy submitted snapshots', (t) => {
    const env = envFor(t)
    const resume = makeResume(env)
    const legacy = JSON.stringify({ resumeVersionId: resume.id, resumeLabel: '旧版仅标识快照', documents: [], materialsSpecified: false, capturedAt: '2026-01-01' })
    const draft = createDraft(env, { resumeVersionId: resume.id })
    env.db.run('UPDATE application SET submission_snapshot = ? WHERE id = ?', [legacy, draft.id])
    assert.equal(env.repos.applications.update(draft.id, { status: 'applied' }).submissionSnapshot.resume.rawText, resume.raw_text)
    const submitted = createDraft(env, { status: 'applied', resumeVersionId: resume.id })
    env.db.run('UPDATE application SET submission_snapshot = ? WHERE id = ?', [legacy, submitted.id])
    env.db.run('UPDATE resume_version SET raw_text = ? WHERE id = ?', ['今天的新内容不是过去的提交事实', resume.id])
    env.repos.applications.update(submitted.id, { status: 'offer' })
    assert.equal(stored(env, submitted.id).submission_snapshot, legacy)
    assert.equal(env.repos.applications.get(submitted.id).submissionSnapshot.resume, undefined)
    assert.ok(env.db.version >= 13, 'submission freeze remains compatible with schema13 and later migrations')
  })
})
