import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { CareerDb } from '../host/db.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../host/schema.js'
import { KnowledgeRepo, Repos } from '../host/repo/index.js'
import { knowledgeUrls } from '../host/repo/knowledge.js'
import { makeEnv, silentLogger } from './helpers.mjs'

const source = (patch = {}) => ({ kind: 'interview', title: '产品面经', platform: 'xiaohongshu',
  url: 'https://www.xiaohongshu.com/explore/note-1?xsec_token=secret&utm_source=share',
  body: '列表摘要', completeness: 'summary', ...patch })
function using(fn) { const env = makeEnv(); try { fn(env) } finally { env.cleanup() } }

describe('knowledge migration 14', () => {
  it('upgrades v13 append-only, preserves existing data and migrates idempotently', () => {
    const logger = silentLogger()
    const db = new CareerDb(':memory:', logger)
    db.db = new DatabaseSync(':memory:')
    try {
      db.appliedVersions()
      for (const migration of MIGRATIONS.filter((m) => m.version <= 13)) db.execMigration(migration)
      db.run('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)', ['existing', 'kept', '2026-01-01'])
      assert.equal(db.scalar('SELECT max(version) FROM schema_migrations'), 13)
      assert.equal(SCHEMA_VERSION, 14)
      assert.equal(db.migrate(), 14)
      assert.equal(db.migrate(), 14)
      assert.equal(db.scalar('SELECT value FROM settings WHERE key=?', ['existing']), 'kept')
      assert.equal(db.scalar('SELECT count(*) FROM schema_migrations WHERE version=14'), 1)
      assert.ok(new Repos(db, logger).knowledge instanceof KnowledgeRepo)
      assert.equal(db.scalar('SELECT count(*) FROM knowledge_revision'), 0)
    } finally { db.close() }
  })
})

describe('KnowledgeRepo source index', () => {
  it('deduplicates links without tracking/token identity and retains the original URL', () => using(({ repos, db }) => {
    const input = source({ media: [{ url: 'https://img.test/a.jpg', ocrStatus: 'pending' }] })
    const first = repos.knowledge.upsert(input)
    assert.equal(first.url, input.url)
    assert.equal(first.company, null)
    assert.equal(first.role, null)
    assert.equal(first.created, true)
    assert.equal(first.revision, 1)
    assert.match(first.normalizedUrl, /xsec_token=secret/)
    assert.doesNotMatch(first.normalizedUrl, /utm_source/)
    assert.doesNotMatch(first.identityUrl, /secret|xsec_token/)
    const second = repos.knowledge.upsert(source({ url: 'https://www.xiaohongshu.com/explore/note-1?utm_campaign=new&xsec_token=changed' }))
    assert.equal(second.id, first.id)
    assert.equal(second.duplicate, true)
    assert.equal(second.url, first.url)
    assert.equal(second.revisions.length, 1)
    assert.equal(db.scalar('SELECT count(*) FROM knowledge'), 1)
    assert.equal(typeof db.scalar('SELECT media FROM knowledge'), 'string', 'JSON uses DB bind facade')
    assert.notEqual(repos.knowledge.upsert(source({ platform: 'other' })).id, first.id)
  }))

  it('retains content query ids and ignores parameter order but not job identity', () => using(({ repos }) => {
    const one = repos.knowledge.upsert(source({ url: 'https://jobs.test/job.html?jobid=1&id=a&note_id=n&postId=p&utm_source=share' }))
    const repeat = repos.knowledge.upsert(source({ url: 'https://jobs.test/job.html?postId=p&note_id=n&id=a&jobid=1&xsec_token=new' }))
    assert.equal(one.id, repeat.id)
    const two = repos.knowledge.upsert(source({ url: 'https://jobs.test/job.html?jobid=2&id=a&note_id=n&postId=p' }))
    assert.notEqual(two.id, one.id)
    assert.match(knowledgeUrls('https://jobs.test/?page=2&gclid=x#hash').identityUrl, /page=2/)
    assert.throws(() => knowledgeUrls('javascript:alert(1)'), /HTTP/)
  }))

  it('indexes external entities without copying jobs or inventing company/role', () => using(({ repos, db }) => {
    const input = source({ kind: 'job', url: null, sourceEntityType: 'job', sourceEntityId: 'external-job-1' })
    const one = repos.knowledge.upsert(input)
    const next = repos.knowledge.upsert({ ...input, body: '详细JD', completeness: 'full' })
    assert.equal(next.id, one.id)
    assert.equal(next.sourceEntityType, 'job')
    assert.equal(next.sourceEntityId, 'external-job-1')
    assert.equal(next.company, null)
    assert.equal(next.role, null)
    assert.equal(db.scalar('SELECT count(*) FROM job'), 0)
    assert.equal(repos.knowledge.upsert(source({ url: null })).id, repos.knowledge.upsert(source({ url: null })).id)
  }))

  it('upgrades body with immutable revision history and never downgrades to a summary', () => using(({ repos }) => {
    const one = repos.knowledge.upsert(source())
    const full = repos.knowledge.upsert(source({ body: '完整面试原文：问题一，问题二及详细回答。', completeness: 'full' }))
    assert.equal(full.id, one.id)
    assert.equal(full.bodyUpdated, true)
    assert.equal(full.revision, 2)
    assert.deepEqual(full.revisions.map((r) => r.body), [one.body, full.body])
    const excerpt = repos.knowledge.upsert(source({ body: '更长的摘要但仍然只是摘要'.repeat(30), completeness: 'summary' }))
    assert.equal(excerpt.body, full.body)
    assert.equal(excerpt.completeness, 'full')
    assert.equal(excerpt.revision, 2)
    assert.equal(repos.knowledge.upsert(source({ body: '', completeness: 'full' })).body, full.body)
    assert.equal(repos.knowledge.get(one.id).revisions[0].body, one.body)
  }))

  it('keeps media OCR evidence independent and records explicit OCR history', () => using(({ repos }) => {
    const pending = [{ url: 'https://img.test/1', ocrStatus: 'pending' }]
    const one = repos.knowledge.upsert(source({ body: '文本正文', completeness: 'full', media: pending }))
    assert.equal(one.media[0].ocrStatus, 'pending', 'full text never implies images were read')
    const reviewed = [{ ...pending[0], ocrStatus: 'reviewed', ocrText: '人工复核文字' }]
    const two = repos.knowledge.updateMedia(one.id, reviewed)
    assert.equal(two.revision, 2)
    assert.equal(two.revisions[0].media[0].ocrStatus, 'pending')
    assert.equal(two.revisions[1].media[0].ocrText, '人工复核文字')
    assert.equal(repos.knowledge.updateMedia(one.id, reviewed).revision, 2)
    const recapture = repos.knowledge.upsert(source({ media: pending }))
    assert.deepEqual(recapture.media, reviewed)
    assert.equal(recapture.body, one.body)
    assert.equal(repos.knowledge.updateMedia('missing', []), null)
    assert.throws(() => repos.knowledge.updateMedia(one.id, {}), /array/)
  }))

  it('combines filters with total/pagination; archives without deleting original sources', () => using(({ repos }) => {
    const repo = repos.knowledge
    const one = repo.upsert(source({ company: '示例公司', role: '产品', body: '中文搜索正文' }))
    repo.upsert(source({ url: 'https://example.test/2', company: '示例公司', kind: 'salary', body: '中文搜索正文' }))
    repo.upsert(source({ url: 'https://example.test/3', company: '别家公司', kind: 'research', platform: 'manual' }))
    const organized = repo.update(one.id, { status: 'archived', company: '示例公司', role: '产品经理', tags: ['校招'], notes: '整理笔记' })
    assert.deepEqual(organized.tags, ['校招'])
    assert.equal(organized.revision, 1)
    const page = repo.list({ query: '中文搜索', kind: 'interview', company: '示例公司', platform: 'XIAOHONGSHU', status: 'archived', limit: 1 })
    assert.equal(page.total, 1)
    assert.equal(page.items[0].id, one.id)
    assert.equal(repo.list({ company: '示例公司', limit: 1, offset: 1 }).total, 2)
    assert.equal(repo.list({ company: '示例公司', limit: 1, offset: 1 }).items.length, 1)
    assert.equal(repo.list({ query: '%' }).total, 0, 'literal wildcard search')
    assert.equal(repo.list({ query: '整理笔记' }).total, 1)
    assert.equal(repo.upsert(source()).status, 'archived', 'recapture must not unarchive')
    assert.equal(repo.get(one.id).body, '中文搜索正文')
    assert.equal(repo.stats().total, 3)
    assert.equal(repo.stats().byKind.interview, 1)
    assert.equal(repo.stats().byKind.announcement, 0)
    assert.deepEqual(repo.stats().byStatus, { inbox: 2, active: 0, archived: 1 })
    assert.equal(repo.stats().byPlatform.xiaohongshu, 2)
    assert.equal(repo.update(one.id, { status: 'active' }).status, 'active')
  }))

  it('rejects silent source overwrite and invalid states atomically', () => using(({ repos }) => {
    const repo = repos.knowledge
    const one = repo.upsert(source())
    for (const key of ['body', 'title', 'url', 'kind', 'media', 'completeness']) {
      assert.throws(() => repo.update(one.id, { status: 'active', [key]: 'overwrite' }), /source-protected/)
    }
    assert.equal(repo.get(one.id).status, 'inbox')
    assert.throws(() => repo.update(one.id, { status: 'deleted' }), /status/)
    assert.throws(() => repo.upsert(source({ kind: 'other' })), /kind/)
    assert.throws(() => repo.upsert(source({ title: '' })), /title/)
    assert.throws(() => repo.upsert(source({ completeness: 'invented' })), /completeness/)
    assert.equal(repo.get('missing'), null)
    assert.equal(repo.update('missing', { status: 'active' }), null)
    assert.equal(repo.stats().total, 1)
  }))
})
