// Company and job storage: normalization, entity resolution, status history,
// provenance and search.
import {
  analyzeMatch,
  computeDedupeKey,
  findJobIdentity,
  normalizeJob,
  statusAgeDays,
} from '../domain.js'
import { arr, bind, companyKey, daysBetween, normKey, nowIso, num, parseJson, sha1ish, str, toBool, uuid } from '../util.js'

export const JOB_COLUMNS = [
  'id', 'dedupe_key', 'company_id', 'company_name', 'title', 'title_key', 'job_code', 'post_id', 'department',
  'business_unit', 'location', 'remote_type', 'internship_type', 'description', 'requirements', 'skills',
  'grade_limit', 'major_limit', 'language_req', 'duration', 'start_date', 'days_per_week', 'salary_text',
  'conversion_possible', 'published_at', 'deadline', 'recruit_type', 'apply_url', 'status', 'status_verified_at',
  'status_source', 'confidence', 'match_score', 'tags', 'notes', 'archived', 'created_at', 'updated_at',
]

const JOB_JSON = new Set(['skills', 'tags'])
const JOB_BOOL = new Set(['archived'])

export function mapJob(row) {
  if (!row) return null
  const out = { ...row }
  for (const f of JOB_JSON) out[f] = parseJson(row[f], [])
  for (const f of JOB_BOOL) out[f] = toBool(row[f])
  if (out.conversion_possible !== null && out.conversion_possible !== undefined) out.conversion_possible = toBool(out.conversion_possible)
  if (out.match_score === null || out.match_score === undefined) out.match_score = null
  return out
}

export class JobRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  // ── companies ──────────────────────────────────────────────────────────────
  resolveCompany(name, create = true) {
    const key = companyKey(name)
    if (!key) return null
    let row = this.db.get('SELECT * FROM company WHERE name_key = ?', [key])
    if (row) return this.recordAlias(row, name)
    // alias hit: aliases are stored as a JSON array of normalized names
    const all = this.db.all("SELECT * FROM company WHERE aliases IS NOT NULL AND aliases <> '[]'")
    for (const cand of all) {
      const aliases = parseJson(cand.aliases, []).map(companyKey)
      if (aliases.includes(key)) return this.recordAlias(cand, name)
    }
    if (!create) return null
    const at = nowIso()
    const id = uuid()
    this.db.run('INSERT INTO company (id, name, name_key, aliases, cities, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, str(name, 200), key, [], [], [], at, at])
    row = this.db.get('SELECT * FROM company WHERE id = ?', [id])
    return this.mapCompany(row)
  }

  /**
   * Keep the legal-name variants we resolved to one employer visible, instead of
   * silently rewriting what the source said.
   */
  recordAlias(row, incomingName) {
    const canonical = String(row.name ?? '')
    const incoming = String(incomingName ?? '').trim()
    if (!incoming || incoming === canonical) return this.mapCompany(row)
    const aliases = parseJson(row.aliases, [])
    if (aliases.includes(incoming)) return this.mapCompany(row)
    if (aliases.length < 24) {
      this.db.run('UPDATE company SET aliases = ?, updated_at = ? WHERE id = ?',
        [[...aliases, incoming], nowIso(), row.id])
    }
    return this.mapCompany(this.db.get('SELECT * FROM company WHERE id = ?', [row.id]))
  }

  mapCompany(row) {
    if (!row) return null
    return {
      ...row,
      aliases: parseJson(row.aliases, []),
      cities: parseJson(row.cities, []),
      tags: parseJson(row.tags, []),
      data: parseJson(row.data, null),
    }
  }

  upsertCompany(input) {
    let company = input.id ? this.mapCompany(this.db.get('SELECT * FROM company WHERE id = ?', [input.id])) : null
    if (!company) company = this.resolveCompany(input.name)
    if (!company) throw new Error('公司名称必填')
    const patch = {
      aliases: input.aliases !== undefined ? arr(input.aliases) : company.aliases,
      industry_id: input.industryId !== undefined ? str(input.industryId, 60) : company.industry_id,
      website: input.website !== undefined ? str(input.website, 500) : company.website,
      careers_url: input.careersUrl !== undefined ? str(input.careersUrl, 1000) : company.careers_url,
      intern_url: input.internUrl !== undefined ? str(input.internUrl, 1000) : company.intern_url,
      cities: input.cities !== undefined ? arr(input.cities) : company.cities,
      size: input.size !== undefined ? str(input.size, 80) : company.size,
      tags: input.tags !== undefined ? arr(input.tags) : company.tags,
      notes: input.notes !== undefined ? str(input.notes, 4000) : company.notes,
      data: input.data !== undefined ? { ...(company.data ?? {}), ...(input.data ?? {}) } : company.data,
    }
    const keys = Object.keys(patch)
    this.db.run(`UPDATE company SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => patch[k]), nowIso(), company.id])
    return this.mapCompany(this.db.get('SELECT * FROM company WHERE id = ?', [company.id]))
  }

  listCompanies({ query, industryId, limit = 200 } = {}) {
    const where = []
    const params = []
    if (industryId) { where.push('industry_id = ?'); params.push(industryId) }
    if (query) { where.push('(name LIKE ? OR aliases LIKE ?)'); params.push(`%${query}%`, `%${query}%`) }
    const sql = `SELECT * FROM company ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`
    return this.db.all(sql, [...params, limit]).map((r) => this.mapCompany(r))
  }

  getCompany(id) {
    const company = this.mapCompany(this.db.get('SELECT * FROM company WHERE id = ?', [id]))
    if (!company) return null
    const jobs = this.listJobs({ companyId: id, limit: 50 })
    const watch = this.db.get('SELECT * FROM company_watch WHERE company_id = ?', [id])
    const reports = this.db.all('SELECT id, kind, title, data_as_of, updated_at FROM research_report WHERE company_id = ? ORDER BY updated_at DESC LIMIT 10', [id])
    const claims = this.db.all('SELECT category, evidence_level, count(*) AS n FROM forum_claim WHERE company_id = ? GROUP BY category, evidence_level', [id])
    return { ...company, jobs, watch: watch ?? null, reports, claimStats: claims }
  }

  setWatch(companyId, interest, note) {
    const at = nowIso()
    const existing = this.db.get('SELECT id FROM company_watch WHERE company_id = ?', [companyId])
    if (existing) {
      this.db.run('UPDATE company_watch SET interest = ?, note = ?, updated_at = ? WHERE id = ?', [str(interest, 20) ?? 'watch', str(note, 1000), at, existing.id])
      return this.db.get('SELECT * FROM company_watch WHERE id = ?', [existing.id])
    }
    const id = uuid()
    this.db.run('INSERT INTO company_watch (id, company_id, interest, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, companyId, str(interest, 20) ?? 'watch', str(note, 1000), at, at])
    return this.db.get('SELECT * FROM company_watch WHERE id = ?', [id])
  }

  // ── jobs ───────────────────────────────────────────────────────────────────
  /**
   * Insert or merge one posting.
   * @param {object} raw connector output / agent payload
   * @param {{source?:object, official?:boolean, matchProfile?:object}} opts
   */
  upsertJob(raw, opts = {}) {
    const job = normalizeJob(raw)
    const company = this.resolveCompany(job.companyName)
    job.companyId = company?.id ?? null
    const dedupeKey = computeDedupeKey(job)
    const identity = findJobIdentity(this.db, { ...job, url: job.url })
    const at = nowIso()

    if (identity) {
      const existing = this.db.get('SELECT * FROM job WHERE id = ?', [identity.id])      // Merge only fields the incoming record actually provides.
      const updates = {}
      const assign = (col, value) => {
        if (value !== null && value !== undefined && value !== '' && value !== existing[col]) updates[col] = value
      }
      assign('job_code', job.jobCode)
      assign('post_id', job.postId)
      assign('department', job.department)
      assign('business_unit', job.businessUnit)
      assign('location', job.location)
      assign('remote_type', job.remoteType)
      assign('internship_type', job.internshipType)
      assign('description', job.description)
      assign('requirements', job.requirements)
      assign('grade_limit', job.gradeLimit)
      assign('major_limit', job.majorLimit)
      assign('language_req', job.languageReq)
      assign('duration', job.duration)
      assign('start_date', job.startDate)
      assign('days_per_week', job.daysPerWeek)
      assign('salary_text', job.salaryText)
      assign('published_at', job.publishedAt)
      assign('deadline', job.deadline)
      assign('recruit_type', job.recruitType)
      assign('apply_url', job.applyUrl)
      if (job.skills.length) updates.skills = [...new Set([...parseJson(existing.skills, []), ...job.skills])]
      if (job.conversionPossible !== null) assign('conversion_possible', job.conversionPossible)
      if (Object.keys(updates).length) {
        this.db.run(`UPDATE job SET ${Object.keys(updates).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          [...Object.values(updates), at, identity.id])
      }
      if (job.url) this.attachSource(identity.id, { ...(opts.source ?? {}), url: job.url, sourceType: opts.source?.sourceType ?? 'manual' })
      const statusResult = this.applyStatusObservation(identity.id, {
        status: this.effectiveStatus(job, opts.official === true),
        official: opts.official === true,
        sourceType: opts.source?.sourceType ?? 'manual',
        sourceUrl: job.url ?? opts.source?.url ?? null,
        evidence: str(raw.statusEvidence ?? raw.evidence, 500),
      })
      return { created: false, id: identity.id, reason: identity.reason, dedupeKey, statusChange: statusResult }
    }

    const id = uuid()
    const row = {
      id,
      dedupe_key: dedupeKey,
      company_id: job.companyId,
      company_name: job.companyName,
      title: job.title,
      title_key: job.titleKey,
      job_code: job.jobCode,
      post_id: job.postId,
      department: job.department,
      business_unit: job.businessUnit,
      location: job.location,
      remote_type: job.remoteType,
      internship_type: job.internshipType,
      description: job.description,
      requirements: job.requirements,
      skills: job.skills,
      grade_limit: job.gradeLimit,
      major_limit: job.majorLimit,
      language_req: job.languageReq,
      duration: job.duration,
      start_date: job.startDate,
      days_per_week: job.daysPerWeek,
      salary_text: job.salaryText,
      conversion_possible: job.conversionPossible,
      published_at: job.publishedAt,
      deadline: job.deadline,
      recruit_type: job.recruitType,
      apply_url: job.applyUrl,
      status: 'UNKNOWN',
      status_verified_at: null,
      status_source: null,
      confidence: job.confidence,
      match_score: null,
      tags: job.tags,
      notes: job.notes,
      archived: 0,
      created_at: at,
      updated_at: at,
    }
    const cols = JOB_COLUMNS.filter((c) => c in row)
    this.db.run(`INSERT INTO job (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]))
    if (job.url) this.attachSource(id, { ...(opts.source ?? {}), url: job.url, sourceType: opts.source?.sourceType ?? 'manual' })
    const statusResult = this.applyStatusObservation(id, {
      status: this.effectiveStatus(job, opts.official === true),
      official: opts.official === true,
      sourceType: opts.source?.sourceType ?? 'manual',
      sourceUrl: job.url ?? opts.source?.url ?? null,
      evidence: str(raw.statusEvidence ?? raw.evidence, 500),
    })
    return { created: true, id, reason: 'new', dedupeKey, statusChange: statusResult }
  }

  /**
   * What a record's status claim actually resolves to. A caller that supplies no
   * status is not claiming anything: an official page still means "open" (the posting
   * is published right there), while a third-party sighting means "unverified".
   */
  effectiveStatus(job, official) {
    if (job.status && job.status !== 'UNKNOWN') return job.status
    return official ? 'OPEN' : 'UNVERIFIED'
  }

  /**
   * Official evidence may change the status. Third-party evidence may only lift an
   * UNKNOWN job to UNVERIFIED — it can never assert "still open".
   */
  applyStatusObservation(jobId, { status, official, sourceType, sourceUrl, evidence, note, verifiedAt }) {
    const job = this.db.get('SELECT id, status, status_verified_at FROM job WHERE id = ?', [jobId])
    if (!job) return null
    const at = verifiedAt ?? nowIso()
    const current = job.status ?? 'UNKNOWN'
    let next = current
    let changed = false

    if (official) {
      if (status && status !== current) { next = status; changed = true }
      this.db.run('UPDATE job SET status = ?, status_verified_at = ?, status_source = ?, updated_at = ? WHERE id = ?',
        [next, at, sourceUrl ?? sourceType ?? null, at, jobId])
    } else {
      if (current === 'UNKNOWN' || current === null) { next = status && status !== 'OPEN' ? status : 'UNVERIFIED'; changed = next !== current }
      if (changed) {
        // Third-party evidence may lift UNKNOWN, but it never stamps verification.
        this.db.run('UPDATE job SET status = ?, updated_at = ? WHERE id = ?', [next, at, jobId])
      }
      // third-party observations never refresh status_verified_at
    }

    if (changed) {
      this.db.run(`INSERT INTO job_status_history (id, job_id, status, previous_status, source_type, source_url, evidence, verified_at, note, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), jobId, next, current, sourceType ?? null, sourceUrl ?? null, evidence ?? null, official ? at : (job.status_verified_at ?? at), note ?? null, at])
    }
    return { previous: current, status: this.db.get('SELECT status FROM job WHERE id = ?', [jobId])?.status ?? next, changed, official: official === true }
  }

  attachSource(jobId, source) {
    if (!source?.url) return null
    const existing = this.db.get('SELECT id FROM job_source WHERE job_id = ? AND source_url = ?', [jobId, source.url])
    if (existing) {
      this.db.run('UPDATE job_source SET retrieved_at = ?, verification_status = coalesce(?, verification_status), evidence_excerpt = coalesce(?, evidence_excerpt) WHERE id = ?',
        [nowIso(), str(source.verificationStatus, 40) ?? null, str(source.excerpt, 500) ?? null, existing.id])
      return existing.id
    }
    const id = uuid()
    const at = nowIso()
    this.db.run(`INSERT INTO job_source (id, job_id, source_type, source_name, source_url, published_at, retrieved_at, verification_status, claim_type, evidence_excerpt, confidence_level, raw_hash, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, jobId,
        str(source.sourceType, 40) ?? 'manual',
        str(source.sourceName, 200),
        str(source.url, 1000),
        str(source.publishedAt, 40),
        at,
        str(source.verificationStatus, 40) ?? (source.sourceType === 'official_careers' ? 'verified' : 'unverified'),
        str(source.claimType, 40) ?? 'job_opening',
        str(source.excerpt, 500),
        str(source.confidenceLevel, 4) ?? (source.sourceType === 'official_careers' ? 'A' : 'C'),
        sha1ish(`${source.url}`),
        at])
    return id
  }

  /**
   * Bulk-import crawled postings. One bad row must not abort the batch, and every
   * outcome is reported so the UI can show what landed vs. what was merged.
   */
  importPostings(postings, { company, pageUrl, official = true, sourceName, pageText, recruitType } = {}) {
    const created = []
    const merged = []
    const failed = []
    for (const posting of postings ?? []) {
      try {
        const payload = {
          ...posting,
          company: posting.company ?? company,
          applyUrl: posting.applyUrl ?? posting.url ?? pageUrl,
          // 调用方显式给的批次最可信（用户就是按这个筛选抓的），
          // 其次才用逐条从正文猜出来的结果——否则正文里一句「2027校园招聘」
          // 就能把实习生岗位标成秋招。
          recruitType: recruitType ?? posting.recruitType ?? null,
          location: posting.location ?? null,
        }
        if (!payload.company) throw new Error('缺少公司名')
        if (!payload.title) throw new Error('缺少岗位名')
        const result = this.upsertJob(payload, {
          official,
          source: {
            sourceType: official ? 'official_careers' : 'job_board',
            sourceName: sourceName ?? (official ? '官方招聘页（爬取）' : '第三方（爬取）'),
            url: posting.url ?? pageUrl,
            excerpt: posting.title,
            confidenceLevel: official ? 'A' : 'C',
          },
        })
        if (result.created) created.push(result.id)
        else merged.push(result.id)
      } catch (err) {
        failed.push({ title: posting?.title ?? null, error: String(err?.message ?? err) })
      }
    }
    return { created, merged, failed, total: (postings ?? []).length }
  }

  /** Every apply URL we know for a job, primary first. */
  applyUrls(jobId) {
    const row = this.db.get('SELECT apply_url FROM job WHERE id = ?', [jobId])
    const sources = this.db.all("SELECT source_url FROM job_source WHERE job_id = ? ORDER BY retrieved_at DESC", [jobId])
    const urls = []
    if (row?.apply_url) urls.push(row.apply_url)
    for (const s of sources) if (s.source_url && !urls.includes(s.source_url)) urls.push(s.source_url)
    return urls
  }

  getJob(id) {
    const job = mapJob(this.db.get('SELECT * FROM job WHERE id = ?', [id]))
    if (!job) return null
    const sources = this.db.all('SELECT * FROM job_source WHERE job_id = ? ORDER BY retrieved_at DESC', [id])
    const history = this.db.all('SELECT * FROM job_status_history WHERE job_id = ? ORDER BY verified_at DESC', [id])
    const notes = this.db.all('SELECT * FROM job_note WHERE job_id = ? ORDER BY created_at DESC', [id])
    const requirements = this.db.all('SELECT * FROM hiring_requirement WHERE job_id = ? ORDER BY kind, created_at', [id])
    const interviews = this.db.all('SELECT * FROM interview_experience WHERE job_id = ? ORDER BY year DESC', [id])
    const company = job.company_id ? this.mapCompany(this.db.get('SELECT * FROM company WHERE id = ?', [job.company_id])) : null
    const match = this.db.get('SELECT * FROM match_result WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', [id])
    const application = this.db.get('SELECT * FROM application WHERE job_id = ? AND archived = 0 ORDER BY created_at DESC LIMIT 1', [id])
    return {
      ...job,
      sources,
      history,
      notes,
      requirements,
      interviews,
      company,
      match: match ? { ...match, breakdown: parseJson(match.breakdown, {}), reasons: parseJson(match.reasons, {}) } : null,
      application: application ?? null,
      statusAgeDays: statusAgeDays(job),
      deadlineInDays: job.deadline ? daysBetween(new Date().toISOString().slice(0, 10), job.deadline) : null,
    }
  }

  /**
   * 补写 JD 正文（来自详情接口）。只填空字段，不覆盖已有内容——
   * 已有的可能来自更权威的来源，不该被列表接口的兜底数据冲掉。
   */
  setJd(jobId, patch = {}) {
    const current = this.db.get('SELECT description, requirements, location, department FROM job WHERE id = ?', [jobId])
    if (!current) return null
    const fields = {}
    const put = (col, value) => {
      if (!value) return
      const existing = current[col]
      if (existing === null || existing === undefined || String(existing).trim() === '') fields[col] = String(value)
    }
    put('description', patch.description)
    put('requirements', patch.requirements)
    put('location', patch.location)
    put('department', patch.department)
    if (!Object.keys(fields).length) return { updated: false, job: this.getJob(jobId) }
    fields.updated_at = nowIso()
    this.db.run(`UPDATE job SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), jobId])
    return { updated: true, filled: Object.keys(fields).filter((k) => k !== 'updated_at'), job: this.getJob(jobId) }
  }

  /** 列出缺 JD 正文的岗位（用于批量补全）。 */
  jobsMissingJd({ company, limit = 200 } = {}) {
    const where = ["archived = 0", "(description IS NULL OR trim(description) = '')"]
    const params = []
    if (company) { where.push('company_name = ?'); params.push(company) }
    return this.db.all(
      `SELECT id, company_name, title, job_code, post_id, apply_url FROM job WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
      [...params, Math.min(Number(limit ?? 200), 1000)],
    )
  }

  addNote(jobId, body, author = '我') {    const id = uuid()
    this.db.run('INSERT INTO job_note (id, job_id, body, author, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, jobId, str(body, 8000), str(author, 80), nowIso()])
    return this.db.get('SELECT * FROM job_note WHERE id = ?', [id])
  }

  listJobs(filter = {}, profile = null) {
    const where = []
    const params = []
    if (filter.archived !== true) where.push('archived = 0')
    if (filter.companyId) { where.push('company_id = ?'); params.push(filter.companyId) }
    if (filter.status) {
      const list = arr(filter.status)
      where.push(`status IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (filter.internshipType) {
      const list = arr(filter.internshipType)
      where.push(`internship_type IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (filter.location) { where.push("(location LIKE ? OR location LIKE ?)"); params.push(`%${filter.location}%`, '%远程%') }
    if (filter.company) { where.push('company_name LIKE ?'); params.push(`%${filter.company}%`) }
    if (filter.deadlineBefore) { where.push('deadline IS NOT NULL AND deadline <= ?'); params.push(filter.deadlineBefore) }
    if (filter.minScore !== undefined && filter.minScore !== null) { where.push('match_score IS NOT NULL AND match_score >= ?'); params.push(num(filter.minScore)) }
    if (filter.skill) { where.push('skills LIKE ?'); params.push(`%${filter.skill}%`) }
    if (filter.recruitType) {
      const list = arr(filter.recruitType)
      where.push(`recruit_type IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (filter.since) { where.push('created_at >= ?'); params.push(filter.since) }

    let ids = null
    if (filter.query) {
      const hits = this.searchJobIds(filter.query, 400)
      if (!hits.length) return []
      ids = hits
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }

    const limit = Math.min(num(filter.limit) ?? 100, 500)
    const offset = Math.max(num(filter.offset) ?? 0, 0)
    const sql = `SELECT * FROM job ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY coalesce(match_score, -1) DESC, updated_at DESC LIMIT ? OFFSET ?`
    const rows = this.db.all(sql, [...params, limit, offset]).map(mapJob)
    return rows
  }

  /** FTS5 MATCH when the tokenizer supports CJK, else a LIKE scan. */
  searchJobIds(query, limit = 100) {
    const q = String(query ?? '').trim()
    if (!q) return []
    if (this.db.ftsMode === 'trigram' && [...q].length >= 3) {
      try {
        const escaped = q.replace(/"/g, '""')
        const rows = this.db.all('SELECT job_id FROM job_fts WHERE job_fts MATCH ? LIMIT ?', [`"${escaped}"`, limit])
        if (rows.length) return rows.map((r) => r.job_id)
      } catch {
        /* fall through to LIKE */
      }
    }
    const like = `%${q}%`
    const rows = this.db.all(
      'SELECT id FROM job WHERE title LIKE ? OR company_name LIKE ? OR description LIKE ? OR requirements LIKE ? OR location LIKE ? LIMIT ?',
      [like, like, like, like, like, limit])
    return rows.map((r) => r.id)
  }

  // ── matching ───────────────────────────────────────────────────────────────
  scoreJob(jobRow, profile) {
    const job = mapJob(jobRow)
    const analysis = analyzeMatch(profile, job)
    const hash = profile.__hash ?? 'adhoc'
    this.db.run(`INSERT INTO match_result (id, job_id, profile_hash, score, band, breakdown, reasons, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(job_id, profile_hash) DO UPDATE SET score = excluded.score, band = excluded.band,
                   breakdown = excluded.breakdown, reasons = excluded.reasons, created_at = excluded.created_at`,
      [uuid(), job.id, hash, analysis.score, analysis.band, analysis.breakdown, analysis.reasons, nowIso()])
    this.db.run('UPDATE job SET match_score = ?, updated_at = updated_at WHERE id = ?', [analysis.score, job.id])
    return analysis
  }

  /** Re-rank every non-archived job for the given profile. */
  rankAll(profile) {
    const hash = profile.__hash ?? 'adhoc'
    this.db.run('DELETE FROM match_result WHERE profile_hash = ?', [hash])
    const rows = this.db.all('SELECT * FROM job WHERE archived = 0')
    const results = []
    this.db.tx(() => {
      for (const row of rows) {
        const job = mapJob(row)
        const analysis = analyzeMatch(profile, job)
        this.db.run(`INSERT INTO match_result (id, job_id, profile_hash, score, band, breakdown, reasons, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), job.id, hash, analysis.score, analysis.band, analysis.breakdown, analysis.reasons, nowIso()])
        this.db.run('UPDATE job SET match_score = ? WHERE id = ?', [analysis.score, job.id])
        results.push({ job, analysis })
      }
    })
    results.sort((a, b) => b.analysis.score - a.analysis.score)
    return results
  }

  setArchived(id, archived) {
    this.db.run('UPDATE job SET archived = ?, updated_at = ? WHERE id = ?', [archived ? 1 : 0, nowIso(), id])
    return mapJob(this.db.get('SELECT * FROM job WHERE id = ?', [id]))
  }

  deleteJob(id) {
    this.db.tx(() => {
      this.db.run('DELETE FROM job_source WHERE job_id = ?', [id])
      this.db.run('DELETE FROM job_status_history WHERE job_id = ?', [id])
      this.db.run('DELETE FROM match_result WHERE job_id = ?', [id])
      this.db.run('DELETE FROM job_note WHERE job_id = ?', [id])
      this.db.run("UPDATE application SET job_id = NULL WHERE job_id = ?", [id])
      this.db.run('DELETE FROM job WHERE id = ?', [id])
    })
    return true
  }

  /**
   * Refresh policy (spec §7.2): an OPEN job whose status has not been re-verified for
   * longer than `maxAgeDays` becomes STALE — never silently "still open".
   */
  expireStale(maxAgeDays = 21) {
    const rows = this.db.all("SELECT id, status, status_verified_at FROM job WHERE status IN ('OPEN','UPCOMING') AND archived = 0")
    let changed = 0
    for (const row of rows) {
      const age = daysBetween(row.status_verified_at)
      if (age !== null && age > maxAgeDays) {
        this.applyStatusObservation(row.id, {
          status: 'STALE', official: true, sourceType: 'system',
          sourceUrl: null, evidence: `超过 ${maxAgeDays} 天未重新核验`,
          note: `自动标记：状态 ${age} 天未核验`, verifiedAt: nowIso(),
        })
        changed += 1
      }
    }
    return changed
  }

  stats() {
    const byStatus = this.db.all('SELECT status, count(*) AS n FROM job WHERE archived = 0 GROUP BY status')
    const total = Number(this.db.scalar('SELECT count(*) FROM job WHERE archived = 0') ?? 0)
    const verified = Number(this.db.scalar("SELECT count(*) FROM job WHERE archived = 0 AND status_verified_at IS NOT NULL") ?? 0)
    // "official" means the job has at least one official-careers provenance row.
    const official = Number(this.db.scalar(
      "SELECT count(DISTINCT js.job_id) FROM job_source js JOIN job j ON j.id = js.job_id WHERE j.archived = 0 AND js.source_type = 'official_careers'") ?? 0)
    const stale = byStatus.find((r) => r.status === 'STALE')?.n ?? 0
    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      verifiedShare: total ? Number((verified / total).toFixed(3)) : 0,
      officialShare: total ? Number((official / total).toFixed(3)) : 0,
      staleShare: total ? Number((Number(stale) / total).toFixed(3)) : 0,
    }
  }
}
