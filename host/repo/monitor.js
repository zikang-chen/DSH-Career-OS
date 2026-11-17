// Monitoring rules, notifications (deduped), sync-run logs, source health and the
// feedback loop that feeds back into recommendation weights.
import { nowIso, num, parseJson, str, toBool, uuid } from '../util.js'

export class MonitorRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  // ── rules ──────────────────────────────────────────────────────────────────
  createRule(input) {
    const kinds = ['careers_page', 'job_deadline', 'social_watch', 'keyword_search']
    const kind = kinds.includes(String(input.kind)) ? String(input.kind) : 'careers_page'
    const id = uuid()
    const at = nowIso()
    this.db.run(`INSERT INTO monitoring_rule (id, name, kind, spec, cadence, enabled, priority, channel, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.name, 200) ?? `${kind} 规则`, kind, input.spec ?? {},
        str(input.cadence, 20) ?? 'daily', input.enabled === false ? 0 : 1,
        str(input.priority, 20) ?? 'normal', str(input.channel, 40) ?? 'panel', at, at])
    return this.getRule(id)
  }

  getRule(id) {
    const row = this.db.get('SELECT * FROM monitoring_rule WHERE id = ?', [id])
    if (!row) return null
    return { ...row, spec: parseJson(row.spec, {}), stats: parseJson(row.stats, {}), enabled: toBool(row.enabled) }
  }

  listRules({ onlyEnabled = false } = {}) {
    const rows = this.db.all(`SELECT * FROM monitoring_rule ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY created_at DESC`)
    return rows.map((r) => ({ ...r, spec: parseJson(r.spec, {}), stats: parseJson(r.stats, {}), enabled: toBool(r.enabled) }))
  }

  updateRule(id, patch = {}) {
    const current = this.db.get('SELECT * FROM monitoring_rule WHERE id = ?', [id])
    if (!current) throw new Error('监控规则不存在')
    const fields = {}
    if (patch.name !== undefined) fields.name = str(patch.name, 200)
    if (patch.spec !== undefined) fields.spec = patch.spec
    if (patch.cadence !== undefined) fields.cadence = str(patch.cadence, 20)
    if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0
    if (patch.priority !== undefined) fields.priority = str(patch.priority, 20)
    if (patch.channel !== undefined) fields.channel = str(patch.channel, 40)
    if (patch.lastRunAt !== undefined) fields.last_run_at = str(patch.lastRunAt, 40)
    if (patch.lastStatus !== undefined) fields.last_status = str(patch.lastStatus, 40)
    if (patch.lastError !== undefined) fields.last_error = str(patch.lastError, 2000)
    if (patch.stats !== undefined) fields.stats = patch.stats
    if (!Object.keys(fields).length) return this.getRule(id)
    fields.updated_at = nowIso()
    this.db.run(`UPDATE monitoring_rule SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), id])
    return this.getRule(id)
  }

  deleteRule(id) {
    this.db.run('DELETE FROM monitoring_rule WHERE id = ?', [id])
    return true
  }

  // ── notifications ──────────────────────────────────────────────────────────
  /** `dedupeKey` makes repeated scans idempotent: the same change never re-notifies. */
  addNotification(input) {
    const dedupeKey = str(input.dedupeKey, 300) ?? uuid()
    const existing = this.db.get('SELECT id FROM notification WHERE dedupe_key = ?', [dedupeKey])
    if (existing) return { id: existing.id, duplicate: true }
    const id = uuid()
    this.db.run(`INSERT INTO notification (id, rule_id, kind, title, body, severity, dedupe_key, job_id, company_id, action, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.ruleId, 60), str(input.kind, 40) ?? 'info', str(input.title, 300) ?? '提醒',
        str(input.body, 4000), str(input.severity, 20) ?? 'info', dedupeKey,
        str(input.jobId, 60), str(input.companyId, 60), str(input.action, 500), nowIso()])
    return { id, duplicate: false }
  }

  listNotifications({ unreadOnly = false, limit = 50 } = {}) {
    const where = ['dismissed_at IS NULL']
    if (unreadOnly) where.push('read_at IS NULL')
    return this.db.all(`SELECT * FROM notification WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, [limit])
  }

  markNotification(id, { read = true, dismissed = false } = {}) {
    this.db.run('UPDATE notification SET read_at = coalesce(?, read_at), dismissed_at = coalesce(?, dismissed_at) WHERE id = ?',
      [read ? nowIso() : null, dismissed ? nowIso() : null, id])
    return this.db.get('SELECT * FROM notification WHERE id = ?', [id])
  }

  unreadCount() {
    return Number(this.db.scalar('SELECT count(*) FROM notification WHERE read_at IS NULL AND dismissed_at IS NULL') ?? 0)
  }

  // ── sync runs ──────────────────────────────────────────────────────────────
  startRun(kind, target) {
    const id = uuid()
    this.db.run('INSERT INTO sync_run (id, kind, target, started_at, status) VALUES (?, ?, ?, ?, ?)',
      [id, str(kind, 40) ?? 'sync', str(target, 500), nowIso(), 'running'])
    return id
  }

  finishRun(id, patch = {}) {
    this.db.run(`UPDATE sync_run SET finished_at = ?, status = ?, fetched = ?, inserted = ?, updated = ?, duplicates = ?, error = ?, meta = ? WHERE id = ?`,
      [nowIso(), str(patch.status, 20) ?? 'ok', num(patch.fetched) ?? 0, num(patch.inserted) ?? 0,
        num(patch.updated) ?? 0, num(patch.duplicates) ?? 0, str(patch.error, 2000), patch.meta ?? null, id])
    return this.db.get('SELECT * FROM sync_run WHERE id = ?', [id])
  }

  listRuns(limit = 30) {
    return this.db.all('SELECT * FROM sync_run ORDER BY started_at DESC LIMIT ?', [limit])
      .map((r) => ({ ...r, meta: parseJson(r.meta, null) }))
  }

  /** Runs left `running` by a crash are closed out on boot with an explicit error. */
  reconcileRuns() {
    const stuck = this.db.all("SELECT id, started_at FROM sync_run WHERE status = 'running'")
    for (const row of stuck) {
      this.db.run("UPDATE sync_run SET status = 'error', finished_at = ?, error = coalesce(error, '进程中断，未完成') WHERE id = ?",
        [nowIso(), row.id])
    }
    return stuck.length
  }

  // ── source health ──────────────────────────────────────────────────────────
  upsertSource(input) {
    const existing = this.db.get('SELECT * FROM source_health WHERE connector = ?', [input.connector])
    const at = nowIso()
    if (existing) {
      this.db.run(`UPDATE source_health SET display_name = coalesce(?, display_name), access_mode = coalesce(?, access_mode),
                   capabilities = coalesce(?, capabilities), enabled = ?, needs_user = ?, rate_limit_note = coalesce(?, rate_limit_note), updated_at = ? WHERE id = ?`,
        [str(input.displayName, 200), str(input.accessMode, 60), input.capabilities !== undefined ? input.capabilities : null,
          input.enabled === false ? 0 : 1, input.needsUser ? 1 : 0, str(input.rateLimitNote, 500), at, existing.id])
      return this.db.get('SELECT * FROM source_health WHERE id = ?', [existing.id])
    }
    const id = uuid()
    this.db.run(`INSERT INTO source_health (id, connector, display_name, access_mode, capabilities, enabled, needs_user, rate_limit_note, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, str(input.connector, 80), str(input.displayName, 200), str(input.accessMode, 60),
        input.capabilities ?? [], input.enabled === false ? 0 : 1, input.needsUser ? 1 : 0, str(input.rateLimitNote, 500), at])
    return this.db.get('SELECT * FROM source_health WHERE id = ?', [id])
  }

  recordSourceResult(connector, { ok, error, fetched = 0, inserted = 0, dedupe = 0, official = 0 }) {
    const row = this.db.get('SELECT * FROM source_health WHERE connector = ?', [connector])
    if (!row) return null
    const at = nowIso()
    if (ok) {
      this.db.run(`UPDATE source_health SET last_ok_at = ?, last_error = NULL, fetch_count = fetch_count + ?, insert_count = insert_count + ?,
                   dedupe_count = dedupe_count + ?, official_count = official_count + ?, updated_at = ? WHERE id = ?`,
        [at, fetched, inserted, dedupe, official, at, row.id])
    } else {
      this.db.run('UPDATE source_health SET last_error_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
        [at, str(error, 2000), at, row.id])
    }
    return this.db.get('SELECT * FROM source_health WHERE id = ?', [row.id])
  }

  listSources() {
    return this.db.all('SELECT * FROM source_health ORDER BY connector').map((r) => ({
      ...r,
      capabilities: parseJson(r.capabilities, []),
      enabled: toBool(r.enabled),
      needsUser: toBool(r.needs_user),
      dedupeRate: r.fetch_count ? Number((r.dedupe_count / r.fetch_count).toFixed(3)) : null,
    }))
  }

  // ── feedback loop ──────────────────────────────────────────────────────────
  addFeedback({ subjectType, subjectId, verdict, note }) {
    const allowed = ['interested', 'not_interested', 'wrong', 'stale', 'applied', 'disqualified', 'research']
    const v = allowed.includes(String(verdict)) ? String(verdict) : 'research'
    const id = uuid()
    this.db.run('INSERT INTO feedback (id, subject_type, subject_id, verdict, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, str(subjectType, 40) ?? 'job', str(subjectId, 60) ?? '', v, str(note, 2000), nowIso()])
    if (subjectType === 'job' && v === 'stale') {
      this.db.run("UPDATE job SET status = 'STALE', updated_at = ? WHERE id = ?", [nowIso(), subjectId])
    }
    if (subjectType === 'job' && v === 'wrong') {
      this.log.warn('user reported wrong job data', { jobId: subjectId, note })
    }
    return this.db.get('SELECT * FROM feedback WHERE id = ?', [id])
  }

  /**
   * Aggregate feedback into suggested weight/dedupe adjustments. Suggestions only —
   * the user decides whether to apply them.
   */
  feedbackSummary() {
    const rows = this.db.all('SELECT verdict, count(*) AS n FROM feedback GROUP BY verdict')
    const total = rows.reduce((a, r) => a + Number(r.n), 0)
    const byVerdict = Object.fromEntries(rows.map((r) => [r.verdict, Number(r.n)]))
    const disqualified = this.db.all(
      "SELECT j.title, j.company_name, count(*) AS n FROM feedback f JOIN job j ON j.id = f.subject_id WHERE f.verdict = 'disqualified' GROUP BY j.title_key ORDER BY n DESC LIMIT 5")
    const suggestions = []
    if ((byVerdict.disqualified ?? 0) >= 3) {
      suggestions.push('多次「不符合条件」反馈：检查画像里的排除条件与城市/出勤限制是否已写全，匹配会先用硬条件过滤。')
    }
    if ((byVerdict.not_interested ?? 0) >= 5) {
      suggestions.push('多次「不感兴趣」：可下调兴趣维度权重（当前 20%），或补充更明确的 target_roles。')
    }
    if ((byVerdict.stale ?? 0) >= 3) {
      suggestions.push('多条「已过期」反馈：缩短招聘状态核验周期，优先给有官方来源的岗位加权。')
    }
    return { total, byVerdict, disqualifiedTitles: disqualified, suggestions }
  }
}
