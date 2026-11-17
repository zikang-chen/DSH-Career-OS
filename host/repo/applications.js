// Application CRM: records, status timeline, board grouping and follow-up prompts.
import { APPLICATION_LABEL, APPLICATION_STATUSES, RECRUIT_LABEL } from '../domain.js'
import { arr, nowIso, num, str, toBool, uuid } from '../util.js'

export function mapApplication(row) {
  if (!row) return null
  return { ...row, archived: toBool(row.archived), statusLabel: APPLICATION_LABEL[row.status] ?? row.status }
}

export class ApplicationRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  create(input) {
    const status = APPLICATION_STATUSES.includes(String(input.status)) ? String(input.status) : 'saved'
    let job = null
    if (input.jobId) job = this.db.get('SELECT * FROM job WHERE id = ?', [input.jobId])
    const companyName = str(input.companyName ?? job?.company_name, 200)
    const jobTitle = str(input.jobTitle ?? job?.title, 300)
    if (!companyName || !jobTitle) throw new Error('公司与岗位名称必填（或给出有效 jobId）')
    const at = nowIso()
    const id = uuid()
    const jobUrl = job ? this.db.get('SELECT source_url FROM job_source WHERE job_id = ? ORDER BY retrieved_at DESC LIMIT 1', [job.id])?.source_url : null
    // Keep the apply URL / location / deadline on the application itself so the record
    // still makes sense after the source job row is archived or refreshed.
    const applyUrl = str(input.applyUrl ?? input.url, 1000) ?? job?.apply_url ?? jobUrl
    const location = str(input.location, 200) ?? job?.location ?? null
    const deadline = str(input.deadline, 40) ?? job?.deadline ?? null
    const recruitType = str(input.recruitType, 40) ?? job?.recruit_type ?? null
    this.db.tx(() => {
      this.db.run(`INSERT INTO application (id, job_id, company_name, job_title, url, apply_url, location, deadline, recruit_type, status, channel, resume_version_id, applied_at, next_action, next_action_at, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, str(input.jobId, 60), companyName, jobTitle, str(input.url ?? jobUrl, 1000), applyUrl, location, deadline, recruitType, status,
          str(input.channel, 120), str(input.resumeVersionId, 60),
          str(input.appliedAt, 40) ?? (status === 'applied' ? at.slice(0, 10) : null),
          str(input.nextAction, 500), str(input.nextActionAt, 40), str(input.notes, 8000), at, at])
      this.db.run('INSERT INTO application_event (id, application_id, type, to_status, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, 'status', status, at, '创建投递记录', at])
    })
    return this.get(id)
  }

  get(id) {
    const app = mapApplication(this.db.get('SELECT * FROM application WHERE id = ?', [id]))
    if (!app) return null
    app.events = this.db.all('SELECT * FROM application_event WHERE application_id = ? ORDER BY at DESC', [id])
    app.job = app.job_id ? this.db.get(
      `SELECT id, title, company_name, status, deadline,
              (SELECT source_url FROM job_source WHERE job_id = job.id ORDER BY retrieved_at DESC LIMIT 1) AS source_url
       FROM job WHERE id = ?`, [app.job_id]) ?? null : null
    return app
  }

  update(id, patch = {}) {
    const current = this.db.get('SELECT * FROM application WHERE id = ?', [id])
    if (!current) throw new Error('投递记录不存在')
    const at = nowIso()
    const nextStatus = patch.status !== undefined && APPLICATION_STATUSES.includes(String(patch.status)) ? String(patch.status) : null
    const fields = {}
    for (const [col, key] of [['next_action', 'nextAction'], ['next_action_at', 'nextActionAt'], ['notes', 'notes'],
      ['channel', 'channel'], ['url', 'url'], ['result', 'result'], ['retro', 'retro'], ['applied_at', 'appliedAt'],
      ['apply_url', 'applyUrl'], ['location', 'location'], ['deadline', 'deadline'], ['recruit_type', 'recruitType'],
      ['company_name', 'companyName'], ['job_title', 'jobTitle']]) {
      if (patch[key] !== undefined) fields[col] = str(patch[key], 8000)
    }
    if (patch.resumeVersionId !== undefined) fields.resume_version_id = str(patch.resumeVersionId, 60)
    if (patch.archived !== undefined) fields.archived = patch.archived ? 1 : 0
    if (nextStatus) fields.status = nextStatus
    if (!Object.keys(fields).length) return this.get(id)
    fields.updated_at = at
    this.db.tx(() => {
      this.db.run(`UPDATE application SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(fields), id])
      if (nextStatus && nextStatus !== current.status) {
        this.db.run('INSERT INTO application_event (id, application_id, type, from_status, to_status, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [uuid(), id, 'status', current.status, nextStatus, at, str(patch.note, 2000) ?? `状态 ${current.status} → ${nextStatus}`, at])
        if (nextStatus === 'applied' && !current.applied_at) {
          this.db.run('UPDATE application SET applied_at = ? WHERE id = ?', [at.slice(0, 10), id])
        }
      } else if (patch.note) {
        this.db.run('INSERT INTO application_event (id, application_id, type, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [uuid(), id, 'note', at, str(patch.note, 4000), at])
      }
    })
    return this.get(id)
  }

  addEvent(id, { type = 'note', note, at }) {
    const stamp = at ?? nowIso()
    this.db.run('INSERT INTO application_event (id, application_id, type, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), id, str(type, 40), stamp, str(note, 8000), nowIso()])
    return this.get(id)
  }

  /**
   * The "已投递清单" query: flat rows with every column the list view needs, plus
   * text/company/recruit filters. Sorted so the most actionable rows come first.
   */
  list({ status, company, query, recruitType, limit = 500, includeArchived = false, sort = 'updated' } = {}) {
    const where = []
    const params = []
    if (!includeArchived) where.push('archived = 0')
    if (status) {
      const list = arr(status)
      where.push(`status IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (company) { where.push('company_name LIKE ?'); params.push(`%${company}%`) }
    if (recruitType) {
      const list = arr(recruitType)
      where.push(`recruit_type IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (query) {
      where.push('(company_name LIKE ? OR job_title LIKE ? OR notes LIKE ? OR channel LIKE ?)')
      const like = `%${query}%`
      params.push(like, like, like, like)
    }
    const orderBy = sort === 'deadline'
      ? 'CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC'
      : sort === 'applied'
        ? 'coalesce(applied_at, created_at) DESC'
        : 'updated_at DESC'
    const sql = `SELECT * FROM application ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ?`
    return this.db.all(sql, [...params, limit]).map((r) => {
      const app = mapApplication(r)
      app.nextActionOverdue = Boolean(app.next_action_at && app.next_action_at < nowIso().slice(0, 10))
      return app
    })
  }

  /** CSV for backup / spreadsheet tracking. UTF-8 BOM so Excel opens it correctly. */
  toCsv(rows) {
    const headers = ['公司', '岗位', '招聘类型', '状态', '渠道', '工作地点', '投递地址', '投递日期', '截止日期', '下一步', '下一步日期', '结果', '备注']
    const escape = (value) => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const lines = [headers.join(',')]
    for (const row of rows) {
      lines.push([
        row.company_name, row.job_title,
        row.recruit_type ? (RECRUIT_LABEL[row.recruit_type] ?? row.recruit_type) : '',
        APPLICATION_LABEL[row.status] ?? row.status,
        row.channel, row.location, row.apply_url ?? row.url,
        row.applied_at, row.deadline, row.next_action, row.next_action_at, row.result, row.notes,
      ].map(escape).join(','))
    }
    return `\uFEFF${lines.join('\r\n')}\r\n`
  }

  /** Kanban grouping in pipeline order. */
  board() {
    const all = this.list({ limit: 500 })
    const columns = APPLICATION_STATUSES.map((status) => ({
      status,
      label: APPLICATION_LABEL[status],
      items: all.filter((a) => a.status === status),
    }))
    return { columns, total: all.length }
  }

  /** Time-driven nudges: overdue follow-ups, upcoming interviews, closing jobs. */
  followUps() {
    const todayStr = nowIso().slice(0, 10)
    const overdue = this.db.all(
      "SELECT * FROM application WHERE archived = 0 AND next_action_at IS NOT NULL AND next_action_at <= ? AND status NOT IN ('offer','rejected','closed','withdrawn') ORDER BY next_action_at",
      [todayStr])
    const stale = this.db.all(
      `SELECT *, cast(julianday(?) - julianday(coalesce(applied_at, created_at)) AS INTEGER) AS age_days
       FROM application WHERE archived = 0 AND status IN ('applied','assessment','written_test')
         AND coalesce(applied_at, created_at) <= date(?, '-14 day')`,
      [todayStr, todayStr])
    const interviews = this.db.all(
      "SELECT * FROM application WHERE archived = 0 AND status IN ('interview_1','interview_2','final','hr') ORDER BY coalesce(next_action_at, updated_at) LIMIT 20")
    return { overdue: overdue.map(mapApplication), stale: stale.map(mapApplication), interviews: interviews.map(mapApplication) }
  }

  delete(id) {
    this.db.tx(() => {
      this.db.run('DELETE FROM application_event WHERE application_id = ?', [id])
      this.db.run('DELETE FROM application WHERE id = ?', [id])
    })
    return true
  }

  stats() {
    const rows = this.db.all('SELECT status, count(*) AS n FROM application WHERE archived = 0 GROUP BY status')
    const total = rows.reduce((a, r) => a + Number(r.n), 0)
    return { total, byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) }
  }
}
