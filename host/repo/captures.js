// 抓取留痕与两次抓取之间的 diff。
//
// 岗位列表是流水：今天 10 条、下周可能 12 条、旧的可能下架、JD 可能悄悄改严。
// 没有留痕就无法回答「这是新岗位还是我上周看过的」「要求是不是变了」。
import { normKey, nowIso, parseJson, str, uuid } from '../util.js'

/** 超过这个天数，抓取结果视为过期，需要重抓。 */
export const STALE_DAYS = 7

/**
 * 抓取新鲜度。
 * @param {string|null} capturedAt ISO 时间
 */
export function captureFreshness(capturedAt, now = nowIso()) {
  if (!capturedAt) {
    return { ageDays: null, stale: true, reason: '从未抓取过', dueAt: null }
  }
  const ageMs = new Date(now).getTime() - new Date(capturedAt).getTime()
  const ageDays = Math.floor(ageMs / 86400000)
  const dueAt = new Date(new Date(capturedAt).getTime() + STALE_DAYS * 86400000).toISOString()
  return {
    ageDays,
    stale: ageDays >= STALE_DAYS,
    reason: ageDays >= STALE_DAYS ? `已过期 ${ageDays} 天（阈值 ${STALE_DAYS} 天）` : `新鲜（${ageDays} 天前抓的）`,
    dueAt,
  }
}

/** 筛选范围的稳定指纹：只有范围相同，两次结果才能直接对比。 */
export function scopeKeyOf(scope) {
  if (!scope) return 'all'
  const parts = []
  const push = (label, value) => {
    if (value === undefined || value === null || value === '') return
    const list = Array.isArray(value) ? value : [value]
    const cleaned = list.map((item) => String(item).trim()).filter(Boolean).sort()
    if (cleaned.length) parts.push(`${label}=${cleaned.join('|')}`)
  }
  if (typeof scope === 'string') return scope.trim() || 'all'
  push('kw', scope.keyword)
  push('city', scope.city ?? scope.cities)
  push('type', scope.recruitType ?? scope.recruitTypes)
  push('cat', scope.category ?? scope.categories)
  return parts.join('&') || 'all'
}

function identityOf(row) {
  // 岗位编号优先；没有编号时用「公司+标题+地点」——与 job 表去重口径保持一致。
  if (row.jobCode) return `code:${normKey(row.jobCode)}`
  return `tk:${normKey(row.companyKey ?? '')}|${normKey(row.title ?? '')}|${normKey(row.location ?? '')}`
}

/**
 * 两次抓取的集合差异。
 * @param {{previous:Array, current:Array}} input
 * @returns {{added:Array, removed:Array, unchanged:number, scopesComparable:boolean, caveat:string}}
 */
export function diffCaptures({ previous = [], current = [], previousScopeKey, currentScopeKey } = {}) {
  const scopesComparable = (previousScopeKey ?? 'all') === (currentScopeKey ?? 'all')
  const before = new Map(previous.map((row) => [identityOf(row), row]))
  const after = new Map(current.map((row) => [identityOf(row), row]))

  const added = []
  const removed = []
  let unchanged = 0
  for (const [key, row] of after) {
    if (before.has(key)) unchanged += 1
    else added.push(row)
  }
  for (const [key, row] of before) {
    if (!after.has(key)) removed.push(row)
  }

  // 范围不同（比如上次只看「产品」这次看了全部）时，消失的岗位不能判定为下架。
  if (!scopesComparable) {
    return {
      added,
      removed: [],
      unchanged,
      scopesComparable: false,
      vanishedButNotClosed: removed,
      caveat: '两次抓取的筛选范围不同，消失的岗位不能判定为下架，只报新增。',
    }
  }
  return {
    added,
    removed,
    unchanged,
    scopesComparable: true,
    vanishedButNotClosed: [],
    caveat: '范围一致，消失的岗位可视为已下架（仍建议以官网复核为准）。',
  }
}

/** JD 正文哈希：标题/地点/截止/描述/要求 任一变化都算内容变化。 */
export function jdHash(row) {
  const text = [row.title, row.location, row.deadline, row.description, row.requirements].map((item) => String(item ?? '')).join('\u0001')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return String(hash >>> 0)
}

/**
 * 同一个岗位两次快照的差异。
 * @returns {{jobId:string, title:string, changedFields:string[]}[]}
 */
export function diffJdSnapshots({ before = [], after = [] } = {}) {
  const beforeMap = new Map(before.map((row) => [row.jobId, row]))
  const changes = []
  for (const row of after) {
    const old = beforeMap.get(row.jobId)
    if (!old) continue
    const fields = []
    for (const field of ['title', 'location', 'deadline', 'description', 'requirements']) {
      if (String(old[field] ?? '') !== String(row[field] ?? '')) fields.push(field)
    }
    if (fields.length) changes.push({ jobId: row.jobId, title: row.title, changedFields: fields })
  }
  return changes
}

export class CaptureRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  record(input) {
    const id = uuid()
    const seen = Array.isArray(input.seenCodes) ? [...new Set(input.seenCodes.filter(Boolean).map(String))] : null
    this.db.run(
      `INSERT INTO company_capture (id, company_key, company_name, source_url, scope, scope_key, captured_at, found, created, merged, stats, note, seen_codes, reported_total, observed_count, is_complete, parse_warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.companyKey, 120), str(input.companyName, 200), str(input.sourceUrl, 1000),
        str(input.scope, 500), str(input.scopeKey, 500) ?? 'all', nowIso(),
        Number(input.found ?? 0), Number(input.created ?? 0), Number(input.merged ?? 0),
        input.stats ? JSON.stringify(input.stats) : null, str(input.note, 1000),
        seen ? JSON.stringify(seen) : null,
        input.reportedTotal === undefined || input.reportedTotal === null ? null : Number(input.reportedTotal),
        input.observedCount === undefined || input.observedCount === null ? Number(input.found ?? 0) : Number(input.observedCount),
        input.isComplete === undefined || input.isComplete === null ? null : (input.isComplete ? 1 : 0),
        input.parseWarnings ? JSON.stringify(input.parseWarnings) : null],
    )
    return this.get(id)
  }

  get(id) {
    const row = this.db.get('SELECT * FROM company_capture WHERE id = ?', [id])
    if (!row) return null
    return {
      ...row,
      stats: parseJson(row.stats, null),
      seenCodes: parseJson(row.seen_codes, null),
      parseWarnings: parseJson(row.parse_warnings, null),
      isComplete: row.is_complete === null || row.is_complete === undefined ? null : Boolean(row.is_complete),
    }
  }

  /** 最近一次抓取（可按筛选范围过滤）。同一毫秒内的插入用 rowid 定序，避免取错。 */
  latest(companyKey, scopeKey) {
    const sql = scopeKey
      ? 'SELECT * FROM company_capture WHERE company_key = ? AND scope_key = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1'
      : 'SELECT * FROM company_capture WHERE company_key = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1'
    const row = scopeKey ? this.db.get(sql, [companyKey, scopeKey]) : this.db.get(sql, [companyKey])
    if (!row) return null
    return { ...row, stats: parseJson(row.stats, null), seenCodes: parseJson(row.seen_codes, null) }
  }

  history(companyKey, limit = 20) {
    return this.db.all(
      `SELECT id, company_key, company_name, source_url, scope_key, captured_at, found, created, merged
       FROM company_capture WHERE company_key = ? ORDER BY captured_at DESC LIMIT ?`,
      [companyKey, Math.min(Number(limit ?? 20), 100)],
    )
  }

  /** 保存一批岗位的 JD 快照。 */
  saveJdSnapshots(rows) {
    const at = nowIso()
    let saved = 0
    this.db.tx(() => {
      for (const row of rows) {
        if (!row.jobId) continue
        this.db.run(
          `INSERT INTO jd_snapshot (id, job_id, company_key, captured_at, title, location, deadline, description, requirements, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), row.jobId, str(row.companyKey, 120), at, str(row.title, 300), str(row.location, 200),
            str(row.deadline, 40), str(row.description, 20000), str(row.requirements, 20000), jdHash(row)],
        )
        saved += 1
      }
    })
    return { saved, capturedAt: at }
  }

  /** 用岗位编号反查库里的 job id（抓完入库后写 JD 快照要用）。 */
  jobIdByCode(companyName, codes = []) {
    const map = new Map()
    const unique = [...new Set(codes.filter(Boolean).map(String))]
    for (const code of unique.slice(0, 2000)) {
      const row = this.db.get(
        'SELECT id FROM job WHERE job_code = ? AND (company_name = ? OR company_name LIKE ?) LIMIT 1',
        [code, companyName ?? '', `%${companyName ?? ''}%`],
      )
      if (row) map.set(code, row.id)
    }
    return map
  }

  /** 上一批 JD 快照（每 jobId 取最近一条）。 */
  previousJdSnapshots(companyKey) {
    const rows = this.db.all(
      `SELECT s.* FROM jd_snapshot s
       JOIN (SELECT job_id, max(captured_at) AS at FROM jd_snapshot WHERE company_key = ? GROUP BY job_id) latest
         ON latest.job_id = s.job_id AND latest.at = s.captured_at
       WHERE s.company_key = ?`,
      [companyKey, companyKey],
    )
    return rows.map((row) => ({
      jobId: row.job_id,
      title: row.title,
      location: row.location,
      deadline: row.deadline,
      description: row.description,
      requirements: row.requirements,
      capturedAt: row.captured_at,
      hash: row.content_hash,
    }))
  }

  /** 某公司当前在库的岗位（用于和「这次抓到的」做集合对比）。 */
  currentJobs(companyName, companyKey) {
    const rows = this.db.all(
      `SELECT j.id, j.title, j.location, j.job_code, j.status
       FROM job j LEFT JOIN company c ON c.id = j.company_id
       WHERE (j.company_name = ? OR c.name_key = ?) AND coalesce(j.status,'') <> 'CLOSED'`,
      [companyName ?? '', companyKey ?? ''],
    )
    return rows.map((row) => ({ jobId: row.id, title: row.title, location: row.location, jobCode: row.job_code, status: row.status }))
  }
}

export const __internal = { identityOf }
