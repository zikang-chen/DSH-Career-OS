// Industry / company research, forum intelligence, hiring bar, interview records,
// research reports and the evidence ledger.
import { EVIDENCE_LEVELS } from '../domain.js'
import { arr, companyKey, nowIso, num, parseJson, sha1ish, str, uuid } from '../util.js'

const LEVELS = Object.keys(EVIDENCE_LEVELS)

function level(v, fallback = 'C') {
  const s = String(v ?? '').toUpperCase()
  return LEVELS.includes(s) ? s : fallback
}

export class IntelRepo {
  constructor(db, log, jobs) {
    this.db = db
    this.log = log
    this.jobs = jobs
  }

  // ── industries ─────────────────────────────────────────────────────────────
  upsertIndustry(input) {
    const name = str(input.name, 200)
    if (!name) throw new Error('行业名称必填')
    const key = name.toLowerCase().replace(/\s+/g, '')
    const at = nowIso()
    const existing = this.db.get('SELECT * FROM industry WHERE name_key = ?', [key])
    if (existing) {
      this.db.run('UPDATE industry SET summary = coalesce(?, summary), data = coalesce(?, data), updated_at = ? WHERE id = ?',
        [str(input.summary, 20000), input.data !== undefined ? input.data : null, at, existing.id])
      return this.getIndustry(existing.id)
    }
    const id = uuid()
    this.db.run('INSERT INTO industry (id, name, name_key, parent_id, summary, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, key, str(input.parentId, 60), str(input.summary, 20000), input.data ?? null, at, at])
    return this.getIndustry(id)
  }

  getIndustry(id) {
    const row = this.db.get('SELECT * FROM industry WHERE id = ?', [id])
    if (!row) return null
    const companies = this.db.all('SELECT id, name, cities, tags FROM company WHERE industry_id = ? ORDER BY name', [id])
    const reports = this.db.all('SELECT id, title, data_as_of, version, updated_at FROM research_report WHERE industry_id = ? ORDER BY updated_at DESC', [id])
    return { ...row, data: parseJson(row.data, null), companies, reports }
  }

  listIndustries() {
    return this.db.all(`SELECT i.*, (SELECT count(*) FROM company c WHERE c.industry_id = i.id) AS company_count
                        FROM industry i ORDER BY i.name`).map((r) => ({ ...r, data: parseJson(r.data, null) }))
  }

  // ── forum posts & claims ───────────────────────────────────────────────────
  /**
   * Store a forum/experience source. `accessMode` records HOW the text was obtained —
   * manual paste and user exports are legal, scraping behind a login is not.
   */
  addForumPost(input) {
    const platform = str(input.platform, 40)
    const content = str(input.content ?? input.excerpt, 20000)
    if (!platform) throw new Error('platform 必填')
    if (!content) throw new Error('需要内容或摘要（不要伪造未取得的内容）')
    const hash = sha1ish(`${platform}|${str(input.url, 1000) ?? ''}|${content}`)
    let identityUrl = null
    try { const u=new URL(input.url); identityUrl=u.origin+u.pathname } catch { /* no URL */ }
    const linked = identityUrl ? this.db.all('SELECT * FROM forum_post WHERE platform = ? AND url LIKE ?', [platform, identityUrl+'%']).find(row=>{try{const u=new URL(row.url);return u.origin+u.pathname===identityUrl}catch{return false}}) : null
    const existing = linked ?? this.db.get('SELECT * FROM forum_post WHERE platform = ? AND content_hash = ?', [platform, hash])
    if (existing) {
      if(content.length > (existing.content_excerpt?.length??0)) this.db.run('UPDATE forum_post SET content_excerpt=?, content_hash=?, retrieved_at=? WHERE id=?',[content.slice(0,20000),hash,nowIso(),existing.id])
      return { ...existing, duplicate: true }
    }
    const at = nowIso()
    const id = uuid()
    const companyId = input.companyId ?? (input.company ? this.jobs.resolveCompany(input.company)?.id ?? null : null)
    let jobId = str(input.jobId, 60) ?? null
    if (!jobId && input.jobTitle && companyId) {
      const matches = this.db.all('SELECT id FROM job WHERE title = ? AND company_id = ? LIMIT 2', [String(input.jobTitle),companyId])
      jobId = matches.length === 1 ? matches[0].id : null
    }
    this.db.run(`INSERT INTO forum_post (id, platform, url, title, author_handle, published_at, retrieved_at, content_excerpt, content_hash, access_mode, company_id, job_id, license_note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, platform, str(input.url, 1000), str(input.title, 300), str(input.author, 120),
        str(input.publishedAt, 40), at, content.slice(0, 8000), hash,
        str(input.accessMode, 40) ?? 'manual_import', companyId, jobId,
        str(input.licenseNote, 500), at])
    return { ...this.db.get('SELECT * FROM forum_post WHERE id = ?', [id]), duplicate: false }
  }

  addClaim(input) {
    const claim = str(input.claim, 4000)
    if (!claim) throw new Error('claim 必填')
    const post = input.postId ? this.db.get('SELECT * FROM forum_post WHERE id = ?', [input.postId]) : null
    const at = nowIso()
    const id = uuid()
    this.db.run(`INSERT INTO forum_claim (id, post_id, category, claim, stance, evidence_level, sample_size, observed_year, department, company_id, job_id, corroboration, first_hand, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, post?.id ?? null, str(input.category, 40) ?? 'experience', claim,
        str(input.stance, 20) ?? 'neutral', level(input.evidenceLevel, post ? 'C' : 'D'),
        num(input.sampleSize), num(input.observedYear), str(input.department, 200),
        input.companyId ?? post?.company_id ?? null, input.jobId ?? post?.job_id ?? null,
        input.corroboration ?? [], input.firstHand ? 1 : 0, at])
    return this.db.get('SELECT * FROM forum_claim WHERE id = ?', [id])
  }

  /**
   * Aggregate claims for one company. Evidence level is only *raised* by independent
   * corroboration — never by repetition of the same content.
   */
  claimsFor({ companyId, jobId, category }) {
    const where = []
    const params = []
    if (companyId) { where.push('company_id = ?'); params.push(companyId) }
    if (jobId) { where.push('job_id = ?'); params.push(jobId) }
    if (category) { where.push('category = ?'); params.push(category) }
    const rows = this.db.all(`SELECT * FROM forum_claim ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 300`,
      params).map((r) => ({ ...r, corroboration: parseJson(r.corroboration, []) }))
    const grouped = {}
    for (const row of rows) {
      const bucket = (grouped[row.category] ??= { category: row.category, items: [], levels: {}, sample: 0 })
      bucket.items.push(row)
      bucket.levels[row.evidence_level] = (bucket.levels[row.evidence_level] ?? 0) + 1
      bucket.sample += 1
    }
    return {
      total: rows.length,
      groups: Object.values(grouped),
      caveat: '论坛经验是自述样本，存在选择偏差；不能当作企业整体事实，也不构成录用概率判断。',
    }
  }

  addInterview(input) {
    const at = nowIso()
    const id = uuid()
    const companyId = input.companyId ?? (input.company ? this.jobs.resolveCompany(input.company)?.id ?? null : null)
    this.db.run(`INSERT INTO interview_experience (id, company_id, job_id, role_title, year, stage, source_post_id, source_url, topics, questions, timeline, outcome, evidence_level, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, companyId, str(input.jobId, 60), str(input.roleTitle, 300), num(input.year), str(input.stage, 40),
        str(input.postId, 60), str(input.url, 1000), arr(input.topics), arr(input.questions),
        str(input.timeline, 2000), str(input.outcome, 200), level(input.evidenceLevel, 'C'), at])
    return this.db.get('SELECT * FROM interview_experience WHERE id = ?', [id])
  }

  listInterviews({ companyId, jobId, limit = 100 } = {}) {
    const where = []
    const params = []
    if (companyId) { where.push('company_id = ?'); params.push(companyId) }
    if (jobId) { where.push('job_id = ?'); params.push(jobId) }
    return this.db.all(`SELECT * FROM interview_experience ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY year DESC, created_at DESC LIMIT ?`,
      [...params, limit]).map((r) => ({ ...r, topics: parseJson(r.topics, []), questions: parseJson(r.questions, []) }))
  }

  addRequirement(input) {
    const text = str(input.text, 2000)
    if (!text) throw new Error('要求内容必填')
    const kinds = ['hard', 'preferred', 'observed', 'unverified']
    const kind = kinds.includes(String(input.kind)) ? String(input.kind) : 'unverified'
    const id = uuid()
    const companyId = input.companyId ?? (input.company ? this.jobs.resolveCompany(input.company)?.id ?? null : null)
    this.db.run(`INSERT INTO hiring_requirement (id, company_id, job_id, kind, text, source_type, source_url, evidence_level, observed_count, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, companyId, str(input.jobId, 60), kind, text, str(input.sourceType, 60), str(input.sourceUrl, 1000),
        level(input.evidenceLevel, kind === 'hard' ? 'A' : 'C'), num(input.observedCount), str(input.note, 1000), nowIso()])
    return this.db.get('SELECT * FROM hiring_requirement WHERE id = ?', [id])
  }

  /** Hiring-bar view that keeps the four requirement classes strictly separate. */
  barFor({ companyId, jobId, company }) {
    const cid = companyId ?? (company ? this.jobs.resolveCompany(company)?.id ?? null : null)
    const where = []
    const params = []
    if (cid) { where.push('(company_id = ? OR company_id IS NULL)'); params.push(cid) }
    if (jobId) { where.push('job_id = ?'); params.push(jobId) }
    const rows = this.db.all(`SELECT * FROM hiring_requirement ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY kind, created_at DESC`,
      params)
    const buckets = { hard: [], preferred: [], observed: [], unverified: [] }
    for (const row of rows) (buckets[row.kind] ??= []).push(row)
    const claims = this.claimsFor({ companyId: cid })
    return {
      companyId: cid,
      hard: buckets.hard,
      preferred: buckets.preferred,
      observed: buckets.observed,
      unverified: buckets.unverified,
      forumSignals: claims.groups?.filter((g) => g.category === 'bar') ?? [],
      disclaimer: 'Hard = 官方明确要求；Preferred = 官方加分项；Observed = 公开经验中的非官方规律；Unverified = 尚无足够依据。求职经验不能推断为绝对门槛，也不给录取概率。',
    }
  }

  // ── research reports & evidence ────────────────────────────────────────────
  saveReport(input) {
    const at = nowIso()
    if (input.id) {
      const existing = this.db.get('SELECT * FROM research_report WHERE id = ?', [input.id])
      if (!existing) throw new Error('报告不存在')
      this.db.run('UPDATE research_report SET title = ?, body = ?, sources = ?, data_as_of = ?, version = version + 1, updated_at = ? WHERE id = ?',
        [str(input.title, 300) ?? existing.title, str(input.body, 200000) ?? existing.body,
          input.sources !== undefined ? arr(input.sources) : existing.sources,
          str(input.dataAsOf, 40) ?? existing.data_as_of, at, input.id])
      return this.db.get('SELECT * FROM research_report WHERE id = ?', [input.id])
    }
    const id = uuid()
    this.db.run(`INSERT INTO research_report (id, kind, title, industry_id, company_id, body, sources, data_as_of, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, str(input.kind, 40) ?? 'company', str(input.title, 300) ?? '研究简报',
        str(input.industryId, 60), str(input.companyId, 60), str(input.body, 200000),
        arr(input.sources), str(input.dataAsOf, 40), at, at])
    return this.db.get('SELECT * FROM research_report WHERE id = ?', [id])
  }

  listReports({ kind, companyId, industryId, limit = 50 } = {}) {
    const where = []
    const params = []
    if (kind) { where.push('kind = ?'); params.push(kind) }
    if (companyId) { where.push('company_id = ?'); params.push(companyId) }
    if (industryId) { where.push('industry_id = ?'); params.push(industryId) }
    return this.db.all(`SELECT id, kind, title, industry_id, company_id, data_as_of, version, updated_at FROM research_report
                        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`, [...params, limit])
  }

  getReport(id) {
    const row = this.db.get('SELECT * FROM research_report WHERE id = ?', [id])
    return row ? { ...row, sources: parseJson(row.sources, []) } : null
  }

  // ── campus recruiting timeline ─────────────────────────────────────────────
  addEvent(input) {
    const title = str(input.title, 300)
    const startsAt = str(input.startsAt ?? input.starts_at, 40)
    if (!title) throw new Error('事件标题必填')
    if (!startsAt) throw new Error('需要 startsAt（YYYY-MM-DD）')
    const id = uuid()
    const companyId = input.companyId ?? (input.company ? this.jobs.resolveCompany(input.company)?.id ?? null : null)
    this.db.run(`INSERT INTO recruit_event (id, season, stage, title, company_id, company_name, starts_at, ends_at, source, source_url, evidence_level, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.season, 40) ?? 'autumn_campus', str(input.stage, 40) ?? 'apply_open', title,
        companyId, str(input.companyName ?? input.company, 200), startsAt, str(input.endsAt ?? input.ends_at, 40),
        str(input.source, 20) ?? 'user', str(input.sourceUrl, 1000), level(input.evidenceLevel, input.source === 'official' ? 'A' : 'C'),
        str(input.note, 1000), nowIso()])
    return this.db.get('SELECT * FROM recruit_event WHERE id = ?', [id])
  }

  listEvents({ companyId, season, from, limit = 100 } = {}) {
    const where = []
    const params = []
    if (companyId) { where.push('company_id = ?'); params.push(companyId) }
    if (season) { where.push('season = ?'); params.push(season) }
    if (from) { where.push('starts_at >= ?'); params.push(from) }
    return this.db.all(`SELECT * FROM recruit_event ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY starts_at LIMIT ?`,
      [...params, limit])
  }

  deleteEvent(id) {
    return this.db.run('DELETE FROM recruit_event WHERE id = ?', [id]).changes > 0
  }

  /** Deletes a forum post; its claims are kept as unattributed unless withClaims is requested. */
  deletePost(id, { withClaims = false } = {}) {
    return this.db.tx(() => {
      const affectedClaims = withClaims
        ? this.db.run('DELETE FROM forum_claim WHERE post_id = ?', [id]).changes
        : this.db.run('UPDATE forum_claim SET post_id = NULL WHERE post_id = ?', [id]).changes
      const removed = this.db.run('DELETE FROM forum_post WHERE id = ?', [id]).changes
      return { removed: removed > 0, claimsRemoved: withClaims ? affectedClaims : 0, claimsDetached: withClaims ? 0 : affectedClaims }
    })
  }

  deleteClaim(id) {
    return this.db.run('DELETE FROM forum_claim WHERE id = ?', [id]).changes > 0
  }

  // ── business units ─────────────────────────────────────────────────────────
  upsertUnit(input) {
    const name = str(input.name, 200)
    if (!name) throw new Error('部门名称必填')
    const companyId = input.companyId ?? (input.company ? this.jobs.resolveCompany(input.company)?.id ?? null : null)
    if (!companyId) throw new Error('需要 companyId 或 company')
    const at = nowIso()
    const existing = this.db.get('SELECT * FROM company_unit WHERE company_id = ? AND name = ?', [companyId, name])
    if (existing) {
      this.db.run(`UPDATE company_unit SET business = coalesce(?, business), strategic_role = coalesce(?, strategic_role),
                   headcount_note = coalesce(?, headcount_note), growth_signals = coalesce(?, growth_signals),
                   risks = coalesce(?, risks), data_as_of = coalesce(?, data_as_of), updated_at = ? WHERE id = ?`,
        [str(input.business, 2000), str(input.strategicRole, 40), str(input.headcountNote, 500),
          input.growthSignals !== undefined ? input.growthSignals : null,
          input.risks !== undefined ? input.risks : null,
          str(input.dataAsOf, 40), at, existing.id])
      return this.mapUnit(this.db.get('SELECT * FROM company_unit WHERE id = ?', [existing.id]))
    }
    const id = uuid()
    this.db.run(`INSERT INTO company_unit (id, company_id, name, business, strategic_role, headcount_note, growth_signals, risks, data_as_of, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, companyId, name, str(input.business, 2000), str(input.strategicRole, 40), str(input.headcountNote, 500),
        input.growthSignals ?? [], input.risks ?? [], str(input.dataAsOf, 40) ?? null, at, at])
    return this.mapUnit(this.db.get('SELECT * FROM company_unit WHERE id = ?', [id]))
  }

  mapUnit(row) {
    if (!row) return null
    return { ...row, growth_signals: parseJson(row.growth_signals, []), risks: parseJson(row.risks, []) }
  }

  listUnits({ companyId } = {}) {
    const rows = this.db.all(`SELECT * FROM company_unit ${companyId ? 'WHERE company_id = ?' : ''} ORDER BY name`,
      companyId ? [companyId] : [])
    return rows.map((r) => this.mapUnit(r))
  }

  // ── market / outlook signals ───────────────────────────────────────────────
  addSignal(input) {
    const claim = str(input.claim, 3000)
    if (!claim) throw new Error('claim 必填（一句话断言）')
    const scope = ['industry', 'company', 'unit'].includes(String(input.scope)) ? String(input.scope) : 'industry'
    const id = uuid()
    this.db.run(`INSERT INTO market_signal (id, scope, industry_id, company_id, unit_id, topic, claim, direction, horizon, evidence_level, source, source_url, as_of, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, scope, str(input.industryId, 60), str(input.companyId, 60), str(input.unitId, 60),
        str(input.topic, 40) ?? null, claim,
        ['positive', 'neutral', 'negative'].includes(String(input.direction)) ? String(input.direction) : 'neutral',
        str(input.horizon, 20) ?? null, level(input.evidenceLevel, 'C'),
        str(input.source, 300), str(input.sourceUrl, 1000), str(input.asOf, 40) ?? nowIso().slice(0, 10), nowIso()])
    return this.db.get('SELECT * FROM market_signal WHERE id = ?', [id])
  }

  listSignals({ scope, industryId, companyId, unitId, limit = 200 } = {}) {
    const where = []
    const params = []
    if (scope) { where.push('scope = ?'); params.push(scope) }
    if (industryId) { where.push('(industry_id = ? OR industry_id IS NULL)'); params.push(industryId) }
    if (companyId) { where.push('(company_id = ? OR company_id IS NULL)'); params.push(companyId) }
    if (unitId) { where.push('unit_id = ?'); params.push(unitId) }
    return this.db.all(`SELECT * FROM market_signal ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY as_of DESC LIMIT ?`,
      [...params, limit])
  }

  addEvidence(input) {    const id = uuid()
    this.db.run(`INSERT INTO evidence (id, subject_type, subject_id, source_type, source_url, published_at, retrieved_at, verification_status, claim_type, evidence_excerpt, confidence_level, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.subjectType, 40) ?? 'company', str(input.subjectId, 60), str(input.sourceType, 60) ?? 'manual',
        str(input.sourceUrl, 1000), str(input.publishedAt, 40), nowIso(), str(input.verificationStatus, 40) ?? 'unverified',
        str(input.claimType, 60), str(input.excerpt, 1000), level(input.confidenceLevel, 'C'), nowIso()])
    return this.db.get('SELECT * FROM evidence WHERE id = ?', [id])
  }

  listEvidence({ subjectType, subjectId, limit = 100 }) {
    const where = []
    const params = []
    if (subjectType) { where.push('subject_type = ?'); params.push(subjectType) }
    if (subjectId) { where.push('subject_id = ?'); params.push(subjectId) }
    return this.db.all(`SELECT * FROM evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY retrieved_at DESC LIMIT ?`,
      [...params, limit])
  }
}
