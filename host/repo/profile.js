// Profile, resume versions and skills.
import { arr, bind, nowIso, num, parseJson, str, toBool, uuid } from '../util.js'
import { EXPERIENCE_KINDS } from '../tailor.js'
import { DOC_CATEGORIES, classifyDocument, titleFromFileName } from '../documents.js'

const PROFILE_ID = 'default'

const JSON_FIELDS = ['internship_types', 'cities', 'target_industries', 'target_roles', 'target_companies', 'excluded', 'skills', 'preferences']

const EXP_JSON = ['bullets', 'tags', 'skills', 'links']

export function mapExperience(row) {
  if (!row) return null
  const out = { ...row }
  for (const field of EXP_JSON) out[field] = parseJson(row[field], [])
  out.verified = toBool(row.verified)
  out.period = [row.start_at, row.end_at].filter(Boolean).join(' – ')
  return out
}

const DOC_JSON = ['tags']

export function mapDocument(row) {
  if (!row) return null
  const out = { ...row }
  for (const field of DOC_JSON) out[field] = parseJson(row[field], [])
  out.verified = toBool(row.verified)
  return out
}

export function mapProfile(row) {
  if (!row) return null
  const out = { ...row }
  for (const f of JSON_FIELDS) out[f] = parseJson(row[f], f === 'preferences' ? {} : [])
  out.onboarded = toBool(row.onboarded)
  out.skills = Array.isArray(out.skills) ? out.skills : []
  out.preferences = out.preferences && typeof out.preferences === 'object' ? out.preferences : {}
  return out
}

export class ProfileRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  /** Always returns a row: a blank profile is created on first read. */
  get() {
    let row = this.db.get('SELECT * FROM user_profile WHERE id = ?', [PROFILE_ID])
    if (!row) {
      const at = nowIso()
      this.db.run(
        `INSERT INTO user_profile (id, created_at, updated_at, skills, preferences, cities, target_industries, target_roles, target_companies, internship_types, excluded)
         VALUES (?, ?, ?, '[]', '{}', '[]', '[]', '[]', '[]', '[]', '[]')`,
        [PROFILE_ID, at, at],
      )
      row = this.db.get('SELECT * FROM user_profile WHERE id = ?', [PROFILE_ID])
    }
    return mapProfile(row)
  }

  /** Called by matcher only: profile plus the text of the active resume. */
  getWithResume() {
    const profile = this.get()
    const active = this.activeResume()
    return {
      ...profile,
      resumeDigest: active ? `${active.raw_text ?? ''}\n${active.parsed ? JSON.stringify(active.parsed) : ''}` : '',
      activeResumeId: active?.id ?? null,
    }
  }

  update(patch = {}) {
    const current = this.get()
    const columns = ['display_name', 'headline', 'school', 'degree', 'major', 'grad_year', 'availability_start',
      'availability_end', 'weekly_days', 'remote_pref', 'salary_min',
      // 网申信息卡要用的联系方式等字段（v9）
      'phone', 'email', 'birth_date', 'gender', 'political_status', 'hometown', 'current_city', 'gpa', 'rank_text']
    const values = {}
    for (const col of columns) {
      const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      if (patch[col] !== undefined || patch[camel] !== undefined) {
        const v = patch[col] !== undefined ? patch[col] : patch[camel]
        values[col] = col === 'grad_year' || col === 'weekly_days' || col === 'salary_min' ? num(v) : str(v, 200)
      }
    }
    const jsonMap = {
      internship_types: 'internshipTypes',
      cities: 'cities',
      target_industries: 'targetIndustries',
      target_roles: 'targetRoles',
      target_companies: 'targetCompanies',
      excluded: 'excluded',
      skills: 'skills',
      preferences: 'preferences',
    }
    for (const [col, camel] of Object.entries(jsonMap)) {
      const v = patch[col] !== undefined ? patch[col] : patch[camel]
      if (v !== undefined) values[col] = Array.isArray(v) || typeof v === 'object' ? v : parseJson(String(v), [])
    }
    if (patch.onboarded !== undefined) values.onboarded = patch.onboarded ? 1 : 0

    const keys = Object.keys(values)
    if (!keys.length) return current
    values.updated_at = nowIso()
    const sets = Object.keys(values).map((k) => `${k} = ?`).join(', ')
    this.db.run(`UPDATE user_profile SET ${sets} WHERE id = ?`, [...Object.values(values), PROFILE_ID])
    return this.get()
  }

  /** Hash of everything the matcher reads — keys the match cache. */
  hash() {
    const p = this.getWithResume()
    const material = [p.school, p.major, p.grad_year, p.weekly_days, p.remote_pref, p.cities, p.target_industries,
      p.target_roles, p.target_companies, p.excluded, p.skills, p.preferences, p.availability_start, p.availability_end, p.degree, p.resumeDigest ?? '']
    let h = 0
    const s = JSON.stringify(material)
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return `p${h.toString(16)}`
  }

  // ── resumes ────────────────────────────────────────────────────────────────
  addResume(input) {
    const at = nowIso()
    const id = uuid()
    this.db.run(
      `INSERT INTO resume_version (id, label, target_role, language, file_name, file_path, mime, raw_text, parsed, parse_status, parse_notes, is_active,
                                   source_type, parent_version_id, target_job_id, tex_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id,
        str(input.label) ?? `简历 ${at.slice(0, 10)}`,
        str(input.targetRole, 200),
        str(input.language, 10) ?? 'zh',
        str(input.fileName, 400),
        str(input.filePath, 1000),
        str(input.mime, 120),
        str(input.rawText, 200000),
        input.parsed ?? null,
        str(input.parseStatus, 40) ?? 'ok',
        str(input.parseNotes, 2000),
        input.setActive === false ? 0 : 1,
        str(input.sourceType, 20) ?? 'paste',
        str(input.parentVersionId, 60),
        str(input.targetJobId, 60),
        str(input.texSource, 400000),
        at, at],
    )
    if (input.setActive !== false) this.db.run('UPDATE resume_version SET is_active = 0 WHERE id <> ?', [id])
    return this.getResume(id)
  }

  /** Persist an edited LaTeX source on a version. */
  setResumeTex(id, tex) {
    this.db.run('UPDATE resume_version SET tex_source = ?, updated_at = ? WHERE id = ?', [str(tex, 400000), nowIso(), id])
    return this.getResume(id)
  }

  getResumeTex(id) {
    return this.db.get('SELECT tex_source FROM resume_version WHERE id = ?', [id])?.tex_source ?? null
  }

  /** Lineage: which version this came from, and which job it was aimed at. */
  resumeLineage(id) {
    const rows = []
    let cursor = this.db.get('SELECT id, label, parent_version_id, target_job_id, source_type, created_at FROM resume_version WHERE id = ?', [id])
    const guard = new Set()
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id)
      rows.push(cursor)
      cursor = cursor.parent_version_id
        ? this.db.get('SELECT id, label, parent_version_id, target_job_id, source_type, created_at FROM resume_version WHERE id = ?', [cursor.parent_version_id])
        : null
    }
    return rows
  }

  // ── experience vault (素材库) ──────────────────────────────────────────────
  addExperience(input) {
    const kind = EXPERIENCE_KINDS.includes(String(input.kind)) ? String(input.kind) : 'project'
    const id = uuid()
    const at = nowIso()
    const bullets = arr(input.bullets)
    if (!bullets.length && !input.organization && !input.role) {
      throw new Error('经历至少要有一个字段：organization / role / bullets')
    }
    // Accept snake_case too: callers (and the model) legitimately pass either shape,
    // and silently dropping a date would corrupt identity/dedupe.
    const pick = (...names) => {
      for (const name of names) if (input[name] !== undefined && input[name] !== null) return input[name]
      return undefined
    }
    this.db.run(
      `INSERT INTO resume_experience (id, kind, organization, role, start_at, end_at, location, bullets, tags, skills, links, evidence, verified, source_resume_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, str(input.organization, 200), str(input.role, 200),
        str(pick('startAt', 'start_at'), 20), str(pick('endAt', 'end_at'), 20),
        str(input.location, 100), bullets, arr(input.tags), arr(input.skills), arr(input.links),
        str(input.evidence, 1000), input.verified ? 1 : 0, str(pick('sourceResumeId', 'source_resume_id'), 60),
        Number.isFinite(Number(pick('sortOrder', 'sort_order'))) ? Number(pick('sortOrder', 'sort_order')) : 0, at, at],
    )
    return this.getExperience(id)
  }

  getExperience(id) {
    const row = this.db.get('SELECT * FROM resume_experience WHERE id = ?', [id])
    return row ? mapExperience(row) : null
  }

  listExperiences({ kind } = {}) {
    const rows = this.db.all(
      `SELECT * FROM resume_experience ${kind ? 'WHERE kind = ?' : ''} ORDER BY sort_order, coalesce(end_at,'') DESC, created_at`,
      kind ? [kind] : [],
    )
    return rows.map(mapExperience)
  }

  updateExperience(id, patch = {}) {
    const current = this.db.get('SELECT * FROM resume_experience WHERE id = ?', [id])
    if (!current) throw new Error('经历不存在')
    const fields = {}
    if (patch.kind !== undefined) fields.kind = EXPERIENCE_KINDS.includes(String(patch.kind)) ? String(patch.kind) : current.kind
    if (patch.organization !== undefined) fields.organization = str(patch.organization, 200)
    if (patch.role !== undefined) fields.role = str(patch.role, 200)
    if (patch.startAt !== undefined || patch.start_at !== undefined) fields.start_at = str(patch.startAt ?? patch.start_at, 20)
    if (patch.endAt !== undefined || patch.end_at !== undefined) fields.end_at = str(patch.endAt ?? patch.end_at, 20)
    if (patch.location !== undefined) fields.location = str(patch.location, 100)
    if (patch.bullets !== undefined) fields.bullets = arr(patch.bullets)
    if (patch.tags !== undefined) fields.tags = arr(patch.tags)
    if (patch.skills !== undefined) fields.skills = arr(patch.skills)
    if (patch.links !== undefined) fields.links = arr(patch.links)
    if (patch.evidence !== undefined) fields.evidence = str(patch.evidence, 1000)
    if (patch.verified !== undefined) fields.verified = patch.verified ? 1 : 0
    if (patch.sortOrder !== undefined) fields.sort_order = Number(patch.sortOrder) || 0
    if (!Object.keys(fields).length) return mapExperience(current)
    fields.updated_at = nowIso()
    this.db.run(`UPDATE resume_experience SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), id])
    return this.getExperience(id)
  }

  deleteExperience(id) {
    return this.db.run('DELETE FROM resume_experience WHERE id = ?', [id]).changes > 0
  }

  /**
   * Seed the vault from a parsed resume. Only what the parser actually found is
   * written; every entry stays `verified = 0` until the user confirms it.
   */
  importExperiencesFromResume(proposal, resumeId) {
    const created = []
    if (!proposal) return created
    const edu = (proposal.education ?? [])[0]
    if (edu && (edu.school || edu.degree)) {
      created.push(this.addExperience({
        kind: 'education',
        organization: edu.school,
        role: edu.degree,
        bullets: [edu.major, edu.gradYear ? `${edu.gradYear} 届` : ''].filter(Boolean),
        sourceResumeId: resumeId,
        sortOrder: -10,
      }))
    }
    for (const item of proposal.experience ?? []) {
      created.push(this.addExperience({
        kind: 'internship',
        organization: item.organization,
        role: item.role,
        startAt: item.start,
        endAt: item.end,
        bullets: item.bullets ?? [],
        sourceResumeId: resumeId,
      }))
    }
    for (const item of proposal.projects ?? []) {
      created.push(this.addExperience({
        kind: 'project',
        organization: item.name,
        bullets: item.bullets ?? [],
        sourceResumeId: resumeId,
      }))
    }
    for (const item of proposal.research ?? []) {
      created.push(this.addExperience({
        kind: 'research',
        organization: item.name,
        bullets: item.bullets ?? [],
        sourceResumeId: resumeId,
      }))
    }
    for (const cert of proposal.certificates ?? []) {
      created.push(this.addExperience({ kind: 'award', organization: cert, bullets: [], sourceResumeId: resumeId }))
    }
    return created
  }

  /** Build a new resume version out of chosen sections (tailoring / LaTeX edits). */
  createVersionFromSections({ label, sections, profile, rawText, texSource, parentVersionId, targetJobId, sourceType = 'tailored', targetRole, setActive = false }) {
    return this.addResume({
      label,
      targetRole,
      rawText,
      texSource,
      sourceType,
      parentVersionId,
      targetJobId,
      parsed: { sections, generatedAt: nowIso() },
      parseStatus: 'ok',
      setActive,
    })
  }

  /** Portable JSON of the whole vault (for the "导出素材库" case). */
  exportVault() {
    return {
      profile: this.get(),
      experiences: this.listExperiences(),
      versions: this.listResumes(),
      exportedAt: nowIso(),
    }
  }

  /**
   * 每个简历版本的原文，供合并用。合并必须基于**原始文本**而不是上次的解析结果——
   * 解析器可能读错（学术型 CV 尤其），原文才是可信来源。
   */
  rawSources({ maxChars = 8000 } = {}) {
    const rows = this.db.all('SELECT id, label, file_name, source_type, parse_status, created_at, raw_text FROM resume_version ORDER BY created_at')
    return rows.map((row) => {
      const text = String(row.raw_text ?? '')
      return {
        id: row.id,
        label: row.label,
        fileName: row.file_name,
        sourceType: row.source_type,
        parseStatus: row.parse_status,
        createdAt: row.created_at,
        chars: text.length,
        truncated: text.length > maxChars,
        text: text.slice(0, maxChars),
      }
    })
  }

  /**
   * 批量写素材库（合并计划的落地端）。dryRun 只校验不写。
   * @param {{creates?:Array, updates?:Array<{id:string,patch:object}>, deletes?:string[]}} ops
   */  applyVaultOps({ creates = [], updates = [], deletes = [] } = {}, { dryRun = false } = {}) {
    if (dryRun) {
      return {
        dryRun: true,
        wouldCreate: creates.length,
        wouldUpdate: updates.length,
        wouldDelete: deletes.length,
        sample: {
          creates: creates.slice(0, 5).map((c) => (c.incoming ?? c).organization ?? (c.incoming ?? c).role ?? null),
          updates: updates.slice(0, 5).map((u) => u.id),
        },
      }
    }
    const created = []
    const updated = []
    const deleted = []
    const failed = []
    this.db.tx(() => {
      for (const item of creates) {
        try {
          created.push(this.addExperience(item.incoming ?? item).id)
        } catch (err) {
          failed.push({ op: 'create', label: (item.incoming ?? item).organization ?? null, error: String(err?.message ?? err) })
        }
      }
      for (const item of updates) {
        try {
          if (!item.id) throw new Error('update 缺少 id')
          updated.push(this.updateExperience(item.id, item.patch ?? {}).id)
        } catch (err) {
          failed.push({ op: 'update', id: item.id ?? null, error: String(err?.message ?? err) })
        }
      }
      for (const id of deletes) {
        try {
          if (this.deleteExperience(id)) deleted.push(id)
        } catch (err) {
          failed.push({ op: 'delete', id, error: String(err?.message ?? err) })
        }
      }
    })
    return { dryRun: false, created: created.length, updated: updated.length, deleted: deleted.length, failed, createdIds: created }
  }

  // ── 个人资料库（证件/成绩/专利等凭据）──────────────────────────────────────
  addDocument(input) {
    const id = uuid()
    const at = nowIso()
    const category = DOC_CATEGORIES.includes(String(input.category)) ? String(input.category) : classifyDocument({ fileName: input.fileName, text: input.rawText })
    const title = str(input.title, 200) ?? titleFromFileName(input.fileName)
    if (!title) throw new Error('资料需要标题（或给文件名）')
    this.db.run(
      `INSERT INTO personal_document (id, category, title, issuer, issued_at, expires_at, credential_id, score, score_value, score_unit,
                                      file_path, file_name, mime, raw_text, tags, verified, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, category, title, str(input.issuer, 200), str(input.issuedAt ?? input.issued_at, 20), str(input.expiresAt, 20),
        str(input.credentialId ?? input.credential_id, 200), str(input.score, 300),
        input.scoreValue !== undefined ? num(input.scoreValue) : (num(input.score_value) ?? null),
        str(input.scoreUnit ?? input.score_unit, 20),
        str(input.filePath ?? input.file_path, 1000), str(input.fileName ?? input.file_name, 400), str(input.mime, 120),
        str(input.rawText ?? input.raw_text, 50000), arr(input.tags), input.verified ? 1 : 0, str(input.notes, 2000), at, at],
    )
    return this.getDocument(id)
  }

  getDocument(id) {
    const row = this.db.get('SELECT * FROM personal_document WHERE id = ?', [id])
    return row ? mapDocument(row) : null
  }

  listDocuments({ category, query, verified } = {}) {
    const where = []
    const params = []
    if (category) {
      const list = arr(category)
      where.push(`category IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (query) {
      where.push('(title LIKE ? OR issuer LIKE ? OR score LIKE ? OR credential_id LIKE ? OR raw_text LIKE ? OR tags LIKE ?)')
      const like = `%${query}%`
      params.push(like, like, like, like, like, like)
    }
    if (verified !== undefined) { where.push('verified = ?'); params.push(verified ? 1 : 0) }
    const sql = `SELECT * FROM personal_document ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY CASE category WHEN 'language' THEN 0 WHEN 'degree' THEN 1 WHEN 'publication' THEN 2
                   WHEN 'patent' THEN 3 WHEN 'award' THEN 4 ELSE 5 END, coalesce(issued_at,'') DESC, created_at DESC`
    return this.db.all(sql, params).map(mapDocument)
  }

  updateDocument(id, patch = {}) {
    const current = this.db.get('SELECT * FROM personal_document WHERE id = ?', [id])
    if (!current) throw new Error('资料不存在')
    const fields = {}
    if (patch.category !== undefined) fields.category = DOC_CATEGORIES.includes(String(patch.category)) ? String(patch.category) : current.category
    if (patch.title !== undefined) fields.title = str(patch.title, 200)
    if (patch.issuer !== undefined) fields.issuer = str(patch.issuer, 200)
    if (patch.issuedAt !== undefined || patch.issued_at !== undefined) fields.issued_at = str(patch.issuedAt ?? patch.issued_at, 20)
    if (patch.expiresAt !== undefined) fields.expires_at = str(patch.expiresAt, 20)
    if (patch.credentialId !== undefined || patch.credential_id !== undefined) fields.credential_id = str(patch.credentialId ?? patch.credential_id, 200)
    if (patch.score !== undefined) fields.score = str(patch.score, 300)
    if (patch.scoreValue !== undefined) fields.score_value = num(patch.scoreValue)
    if (patch.scoreUnit !== undefined) fields.score_unit = str(patch.scoreUnit, 20)
    if (patch.tags !== undefined) fields.tags = arr(patch.tags)
    if (patch.verified !== undefined) fields.verified = patch.verified ? 1 : 0
    if (patch.notes !== undefined) fields.notes = str(patch.notes, 2000)
    if (!Object.keys(fields).length) return mapDocument(current)
    fields.updated_at = nowIso()
    this.db.run(`UPDATE personal_document SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), id])
    return this.getDocument(id)
  }

  deleteDocument(id) {
    return this.db.run('DELETE FROM personal_document WHERE id = ?', [id]).changes > 0
  }

  documentStats() {
    const rows = this.db.all('SELECT category, count(*) AS n, sum(verified) AS v FROM personal_document GROUP BY category')
    const byCategory = Object.fromEntries(rows.map((row) => [row.category, Number(row.n)]))
    return {
      total: rows.reduce((sum, row) => sum + Number(row.n), 0),
      verified: rows.reduce((sum, row) => sum + Number(row.v ?? 0), 0),
      byCategory,
    }
  }

  getResume(id) {
    const row = this.db.get('SELECT * FROM resume_version WHERE id = ?', [id])
    if (!row) return null
    return { ...row, parsed: parseJson(row.parsed, null), is_active: toBool(row.is_active) }
  }

  listResumes() {
    return this.db.all('SELECT id, label, target_role, language, file_name, parse_status, is_active, created_at, updated_at, length(coalesce(raw_text,\'\')) AS text_length FROM resume_version ORDER BY is_active DESC, created_at DESC')
      .map((r) => ({ ...r, is_active: toBool(r.is_active) }))
  }

  activeResume() {
    const row = this.db.get('SELECT * FROM resume_version WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
    if (!row) return null
    return { ...row, parsed: parseJson(row.parsed, null), is_active: true }
  }

  setActiveResume(id) {
    this.db.run('UPDATE resume_version SET is_active = 0')
    this.db.run('UPDATE resume_version SET is_active = 1, updated_at = ? WHERE id = ?', [nowIso(), id])
    return this.activeResume()
  }

  updateResumeParsed(id, parsed, status = 'needs_review', notes = null) {
    this.db.run('UPDATE resume_version SET parsed = ?, parse_status = ?, parse_notes = ?, updated_at = ? WHERE id = ?',
      [parsed, status, notes, nowIso(), id])
    return this.getResume(id)
  }

  deleteResume(id) {
    const res = this.db.run('DELETE FROM resume_version WHERE id = ?', [id])
    return res.changes > 0
  }

  /** Diff two versions for the "版本对比" view. */
  compareResumes(aId, bId) {
    const a = this.getResume(aId)
    const b = this.getResume(bId)
    if (!a || !b) throw new Error('简历版本不存在')
    const lines = (r) => String(r.raw_text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
    const setA = new Set(lines(a))
    const setB = new Set(lines(b))
    return {
      a: { id: a.id, label: a.label, chars: (a.raw_text ?? '').length },
      b: { id: b.id, label: b.label, chars: (b.raw_text ?? '').length },
      removed: [...setA].filter((l) => !setB.has(l)).slice(0, 200),
      added: [...setB].filter((l) => !setA.has(l)).slice(0, 200),
    }
  }

  // ── skills ─────────────────────────────────────────────────────────────────
  upsertSkill(input) {
    const name = str(input.name, 200)
    if (!name) throw new Error('技能名称必填')
    const key = name.toLowerCase()
    const existing = this.db.get('SELECT id FROM skill WHERE name_key = ?', [key])
    const at = nowIso()
    if (existing) {
      this.db.run('UPDATE skill SET name = ?, category = coalesce(?, category), level = coalesce(?, level), years = coalesce(?, years), verified = ?, evidence = coalesce(?, evidence), updated_at = ? WHERE id = ?',
        [name, str(input.category, 80) ?? null, str(input.level, 40) ?? null, num(input.years), input.verified ? 1 : 0, str(input.evidence, 1000) ?? null, at, existing.id])
      return this.db.get('SELECT * FROM skill WHERE id = ?', [existing.id])
    }
    const id = uuid()
    this.db.run('INSERT INTO skill (id, name, name_key, category, level, years, verified, evidence, source_resume_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, key, str(input.category, 80) ?? null, str(input.level, 40) ?? null, num(input.years), input.verified ? 1 : 0, str(input.evidence, 1000) ?? null, str(input.sourceResumeId, 60) ?? null, at, at])
    return this.db.get('SELECT * FROM skill WHERE id = ?', [id])
  }

  listSkills() {
    return this.db.all('SELECT * FROM skill ORDER BY verified DESC, name').map((r) => ({ ...r, verified: toBool(r.verified) }))
  }

  /** Merge skills table into the profile JSON so the matcher sees one source. */
  syncProfileSkills() {
    const skills = this.listSkills().map((s) => ({ name: s.name, level: s.level, years: s.years, verified: s.verified }))
    this.db.run('UPDATE user_profile SET skills = ?, updated_at = ? WHERE id = ?', [skills, nowIso(), PROFILE_ID])
    return skills
  }

  /** Completeness checklist driving the onboarding screen. */
  completeness() {
    const p = this.get()
    const active = this.activeResume()
    const checks = [
      { key: 'identity', label: '基本身份信息', done: Boolean(p.display_name && p.school) },
      { key: 'education', label: '学历与毕业时间', done: Boolean(p.degree && p.grad_year) },
      { key: 'resume', label: '至少一版简历', done: Boolean(active) },
      { key: 'availability', label: '可实习时间与每周出勤', done: Boolean(p.availability_start && p.weekly_days) },
      { key: 'targets', label: '目标行业/岗位', done: arr(p.target_industries).length > 0 && arr(p.target_roles).length > 0 },
      { key: 'cities', label: '目标城市', done: arr(p.cities).length > 0 },
      { key: 'skills', label: '技能列表', done: arr(p.skills).length > 0 },
    ]
    const done = checks.filter((c) => c.done).length
    return { checks, done, total: checks.length, percent: Math.round((done / checks.length) * 100) }
  }
}
