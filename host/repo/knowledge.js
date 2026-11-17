// Unified source index. Ingestion may enrich facts; organization never rewrites sources.
import { createHash } from 'node:crypto'
import { arr, nowIso, parseJson, str, uuid } from '../util.js'

const KINDS = ['job', 'interview', 'announcement', 'salary', 'research']
const STATUSES = ['inbox', 'active', 'archived']
const RANK = { metadata: 0, summary: 1, partial: 2, full: 3 }
const TRACKING = /^(utm_.+|spm|from|source|ref|referrer|referer|share_.+|share|tracking_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid)$/i
const TOKENS = /^(xsec_token|xsec_source|access_token|token)$/i
const text = (v) => v == null ? '' : String(v)
const digest = (v) => createHash('sha256').update(v).digest('hex')

/** Keep the original URL separately; never discard content-id query parameters. */
export function knowledgeUrls(raw) {
  if (!raw) return { normalizedUrl: null, identityUrl: null }
  let url
  try { url = new URL(raw) } catch { throw new Error('knowledge url must be an absolute HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('knowledge url must be HTTP(S)')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  const normalizedUrl = url.href
  for (const key of [...url.searchParams.keys()]) if (TOKENS.test(key)) url.searchParams.delete(key)
  return { normalizedUrl, identityUrl: url.href }
}

function completeness(value, body) {
  const aliases = { snippet: 'summary', excerpt: 'summary', 'list-only': 'summary', detail: 'full', complete: 'full', body: 'full' }
  const name = aliases[value] ?? value ?? (body ? 'summary' : 'metadata')
  if (!(name in RANK)) throw new Error('invalid knowledge completeness')
  return body ? name : 'metadata'
}
function status(value) {
  if (!STATUSES.includes(value)) throw new Error('invalid knowledge status')
  return value
}
function media(value) {
  if (!Array.isArray(value)) throw new Error('knowledge media must be an array')
  // Round-trip to detach caller-owned objects and validate JSON before writing.
  return JSON.parse(JSON.stringify(value))
}
function item(row) {
  if (!row) return null
  return {
    id: row.id, kind: row.kind, title: row.title, company: row.company, role: row.role,
    platform: row.platform, url: row.url, normalizedUrl: row.normalized_url, identityUrl: row.identity_url,
    publishedAt: row.published_at, body: row.body, status: row.status, evidenceLevel: row.evidence_level,
    completeness: row.completeness, media: parseJson(row.media, []),
    sourceEntityType: row.source_entity_type, sourceEntityId: row.source_entity_id,
    tags: parseJson(row.tags, []), notes: row.notes, revision: row.revision,
    retrievedAt: row.created_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class KnowledgeRepo {
  constructor(db, log) { this.db = db; this.log = log }

  /** Returns an item plus created/updated/duplicate/bodyUpdated ingestion flags. */
  upsert(input) {
    const kind = input.kind
    if (!KINDS.includes(kind)) throw new Error('invalid knowledge kind')
    const title = str(input.title, 2000)
    if (!title) throw new Error('knowledge title required')
    const platform = str(input.platform, 100)?.toLowerCase() ?? 'manual'
    const url = input.url == null || input.url === '' ? null : String(input.url)
    const urls = knowledgeUrls(url)
    const body = text(input.body)
    const quality = completeness(input.completeness, body)
    const sourceEntityType = str(input.sourceEntityType, 100)
    const sourceEntityId = str(input.sourceEntityId, 200)
    const identity = urls.identityUrl ? `url:${urls.identityUrl}`
      : sourceEntityType && sourceEntityId ? `entity:${sourceEntityType}:${sourceEntityId}`
        : `text:${digest(JSON.stringify([kind, title, body]))}`
    const identityKey = digest(JSON.stringify([platform, identity]))
    const incomingMedia = input.media === undefined ? undefined : media(input.media)
    if (input.status !== undefined) status(input.status)
    return this.db.tx(() => {
      const old = this.db.get('SELECT * FROM knowledge WHERE identity_key = ?', [identityKey])
        ?? (sourceEntityType && sourceEntityId ? this.db.get('SELECT * FROM knowledge WHERE source_entity_type=? AND source_entity_id=? ORDER BY created_at LIMIT 1',[sourceEntityType,sourceEntityId]) : null)
      const at = nowIso()
      if (!old) {
        const id = uuid()
        this.db.run(`INSERT INTO knowledge (id,identity_key,kind,title,company,role,platform,url,normalized_url,identity_url,
          published_at,body,status,evidence_level,completeness,media,source_entity_type,source_entity_id,tags,notes,revision,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, identityKey, kind, title, str(input.company, 500), str(input.role, 500), platform, url,
          urls.normalizedUrl, urls.identityUrl, str(input.publishedAt, 100), body, input.status ?? 'inbox',
          str(input.evidenceLevel, 20) ?? 'U', quality, incomingMedia ?? [], sourceEntityType, sourceEntityId, [], null, 1, at, at])
        this.saveRevision(id)
        return { ...this.get(id), created: true, updated: false, duplicate: false, bodyUpdated: !!body }
      }
      // Equal-rank shorter captures are conservatively treated as excerpts. Explicit
      // full captures may revise a full source to shorter text (e.g. source correction).
      const bodyUpdated = body !== old.body && !!body && (RANK[quality] > RANK[old.completeness]
        || (RANK[quality] === RANK[old.completeness] && (body.length >= old.body.length || quality === 'full' && input.completeness === 'full')))
      const next = { ...old }
      // Never reset user organization (including archived status) on repeated capture.
      for (const [key, value] of Object.entries({ company: str(input.company, 500), role: str(input.role, 500),
        published_at: str(input.publishedAt, 100), source_entity_type: sourceEntityType, source_entity_id: sourceEntityId })) {
        if (!next[key] && value) next[key] = value
      }
      const qualityUpdated = body === old.body && RANK[quality] > RANK[old.completeness]
      if (bodyUpdated) next.body = body
      if (bodyUpdated || qualityUpdated) next.completeness = quality
      // Existing rich media/OCR is only changed through updateMedia, not a list refresh.
      if (incomingMedia?.length && !parseJson(old.media, []).length) next.media = JSON.stringify(incomingMedia)
      const revisionChanged = bodyUpdated || qualityUpdated || next.media !== old.media
      const changed = revisionChanged || ['company','role','published_at','source_entity_type','source_entity_id'].some((key) => next[key] !== old[key])
      if (changed) {
        this.db.run(`UPDATE knowledge SET company=?,role=?,published_at=?,body=?,completeness=?,media=?,
          source_entity_type=?,source_entity_id=?,revision=?,updated_at=? WHERE id=?`,
        [next.company, next.role, next.published_at, next.body, next.completeness, next.media,
          next.source_entity_type, next.source_entity_id, old.revision + (revisionChanged ? 1 : 0), at, old.id])
        if (revisionChanged) this.saveRevision(old.id)
      }
      return { ...this.get(old.id), created: false, updated: changed, duplicate: !changed, bodyUpdated }
    })
  }

  saveRevision(id) {
    const row = this.db.get('SELECT * FROM knowledge WHERE id=?', [id])
    this.db.run(`INSERT INTO knowledge_revision (id,knowledge_id,revision,body,completeness,url,media,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [uuid(), id, row.revision, row.body, row.completeness, row.url, row.media, nowIso()])
  }

  get(id) {
    const value = item(this.db.get('SELECT * FROM knowledge WHERE id=?', [id]))
    if (!value) return null
    value.revisions = this.db.all('SELECT * FROM knowledge_revision WHERE knowledge_id=? ORDER BY revision', [id]).map((r) => ({
      id: r.id, knowledgeId: r.knowledge_id, revision: r.revision, body: r.body, completeness: r.completeness,
      url: r.url, media: parseJson(r.media, []), createdAt: r.created_at,
    }))
    return value
  }

  list({ query, kind, company, platform, status: state, limit = 50, offset = 0 } = {}) {
    const where = [], params = []
    for (const [column, value] of Object.entries({ kind, company, platform: platform?.toLowerCase(), status: state })) {
      if (value) { where.push(`${column}=?`); params.push(value) }
    }
    if (query) {
      const escaped = String(query).replace(/[\\%_]/g, '\\$&')
      where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')`)
      params.push(...Array(6).fill(`%${escaped}%`))
    }
    limit = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 50))
    offset = Math.max(0, Math.trunc(Number(offset)) || 0)
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.scalar(`SELECT count(*) FROM knowledge${clause}`, params))
    const items = this.db.all(`SELECT * FROM knowledge${clause} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`, [...params, limit, offset]).map(item)
    return { items, total, limit, offset }
  }

  update(id, patch) {
    const allowed = ['status', 'company', 'role', 'tags', 'notes']
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`knowledge field is source-protected: ${key}`)
    if (!this.get(id)) return null
    const columns = [], params = []
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key}=?`)
      params.push(key === 'status' ? status(value) : key === 'tags' ? arr(value) : str(value, key === 'notes' ? 100000 : 500))
    }
    if (columns.length) this.db.run(`UPDATE knowledge SET ${columns.join(',')},updated_at=? WHERE id=?`, [...params, nowIso(), id])
    return this.get(id)
  }

  /** OCR/media changes are explicit source revisions, independent of text completeness. */
  updateMedia(id, value) {
    const next = media(value)
    return this.db.tx(() => {
      const old = this.get(id)
      if (!old) return null
      if (JSON.stringify(old.media) !== JSON.stringify(next)) {
        this.db.run('UPDATE knowledge SET media=?,revision=revision+1,updated_at=? WHERE id=?', [next, nowIso(), id])
        this.saveRevision(id)
      }
      return this.get(id)
    })
  }

  stats() {
    const grouped = (column, defaults = {}) => Object.assign(defaults, Object.fromEntries(this.db.all(`SELECT ${column} AS key,count(*) AS n FROM knowledge GROUP BY ${column}`).map((r) => [r.key, Number(r.n)])))
    return { total: Number(this.db.scalar('SELECT count(*) FROM knowledge')),
      byKind: grouped('kind', Object.fromEntries(KINDS.map((k) => [k, 0]))),
      byStatus: grouped('status', Object.fromEntries(STATUSES.map((k) => [k, 0]))), byPlatform: grouped('platform') }
  }
}
