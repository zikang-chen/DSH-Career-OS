// Research/crawl budget: agent-adjustable defaults with a hard safety ceiling it cannot raise.
const DEFAULTS = { maxVisits: 6, timeoutMs: 90000, maxConcurrent: 1, cacheTtlMs: 300000 }
const SAFETY = { maxVisits: 12, timeoutMs: 120000, maxConcurrent: 2, cacheTtlMs: 600000 }
const MIN = { maxVisits: 1, timeoutMs: 5000, maxConcurrent: 1, cacheTtlMs: 0 }
const KEY = 'research_budget'

const clampInt = (value, min, max) => {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

export function readResearchBudget(db) {
  let stored = {}
  try {
    const row = db?.get?.('SELECT value FROM settings WHERE key = ?', [KEY])
    stored = row?.value ? JSON.parse(row.value) : {}
  } catch { stored = {} }
  const settings = {}
  const clamped = []
  for (const key of Object.keys(DEFAULTS)) {
    const wanted = stored[key]
    const safe = clampInt(wanted, MIN[key], SAFETY[key])
    if (safe === null) { settings[key] = DEFAULTS[key]; continue }
    settings[key] = safe
    if (Number(wanted) !== safe) clamped.push({ key, stored: wanted, applied: safe, reason: Number(wanted) > SAFETY[key] ? 'over-safety' : 'below-minimum' })
  }
  return { settings, clamped, safety: SAFETY, defaults: DEFAULTS, minimums: MIN }
}

/** Agent-facing write path. Values above the safety ceiling are rejected, not silently lowered. */
export function updateResearchBudget(db, patch = {}) {
  const current = readResearchBudget(db).settings
  const next = { ...current }
  const rejected = []
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue
    const n = Number(patch[key])
    if (!Number.isFinite(n) || !Number.isInteger(Math.trunc(n))) { rejected.push({ key, value: patch[key], reason: '不是整数' }); continue }
    const value = Math.trunc(n)
    if (value > SAFETY[key]) { rejected.push({ key, value, reason: `超过安全上限 ${SAFETY[key]}（${key === 'timeoutMs' ? '毫秒' : key === 'cacheTtlMs' ? '毫秒' : '个'}）` }); continue }
    if (value < MIN[key]) { rejected.push({ key, value, reason: `低于最小值 ${MIN[key]}` }); continue }
    next[key] = value
  }
  if (rejected.length) {
    return { ok: false, error: '部分预算值未通过安全检查，未写入任何改动', rejected, current, safety: SAFETY }
  }
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(next), new Date().toISOString()])
  return { ok: true, ...readResearchBudget(db), note: '预算已保存；安全上限不会随设置提高，也不会被本工具覆盖。' }
}

export function researchBudgetFor(db, overrides = {}) {
  const { settings } = readResearchBudget(db)
  const merged = { ...settings }
  for (const key of Object.keys(DEFAULTS)) {
    const value = overrides[key]
    if (value === undefined || value === null || value === '') continue
    // A caller-supplied override is still clamped: the ceiling is not negotiable per call.
    const safe = clampInt(value, MIN[key], SAFETY[key])
    if (safe !== null) merged[key] = safe
  }
  return merged
}

export const RESEARCH_BUDGET_SAFETY = SAFETY
export const RESEARCH_BUDGET_DEFAULTS = DEFAULTS
