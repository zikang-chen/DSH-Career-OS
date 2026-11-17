// Application CRM: records, status timeline, board grouping and follow-up prompts.
import { APPLICATION_LABEL, APPLICATION_STATUSES, RECRUIT_LABEL } from '../domain.js'
import { computeFunnel, stageIndexOf } from '../funnel.js'
import { buildSubmissionSnapshot } from '../submission.js'
import { arr, nowIso, parseJson, str, toBool, uuid } from '../util.js'

// 原 import 路径保持可用，真实内容快照的纯函数实现移到独立模块。
export { buildSubmissionSnapshot } from '../submission.js'

const materialIds = (value) => [...new Set(arr(value))]
const sameIds = (a, b) => {
  const sorted = [...b].sort()
  return a.length === b.length && [...a].sort().every((id, i) => id === sorted[i])
}
const submittedBefore = (application, events = []) => {
  const snapshot = parseJson(application.submission_snapshot, null)
  return Boolean(snapshot?.frozen || snapshot?.state === 'submitted' || application.applied_at
    || stageIndexOf(application.status) >= 0 || events.some((event) => stageIndexOf(event.to_status) >= 0))
}

/** 读取选定材料的完整行；不能悄悄把已删除/拼错的 id 当成「没有提交材料」。须在写事务内调用。 */
function readMaterials(db, resumeVersionId, docIds) {
  const resumeVersion = resumeVersionId ? db.get('SELECT * FROM resume_version WHERE id = ?', [resumeVersionId]) : null
  if (resumeVersionId && !resumeVersion) throw new Error(`选定简历版本不存在：${resumeVersionId}；请重新选择后再保存或投递`)
  const documents = docIds.map((id) => {
    const doc = db.get('SELECT * FROM personal_document WHERE id = ?', [id])
    if (!doc) throw new Error(`选定资料不存在：${id}；请重新选择后再保存或投递`)
    return doc
  })
  return { resumeVersion, documents }
}

/** 用户粘贴的 JD 优先；否则草稿刷新/首次正式投递时读最新岗位正文。 */
function refreshJd({ current, patch, job, applyUrl, location, deadline, at }) {
  const previous = parseJson(current?.submitted_jd, null)
  if (patch.jd !== undefined) return freezeJd({ job, jd: patch.jd, jdUrl: patch.jdUrl ?? current?.jd_url, applyUrl, location, deadline })
  if (previous?.source === 'user') return { ...previous, jdUrl: str(patch.jdUrl ?? previous.jdUrl, 1000), capturedAt: at }
  if (job) return freezeJd({ job, applyUrl, location, deadline })
  // 岗位被删除时保留已有原文，不伪造一个「重新抓到了」的来源。
  return previous ?? null
}

/**
 * 冻结此刻的岗位 JD。
 * 岗位行会被 sync 刷新、甚至被删，但「我当时投的是什么要求」必须留得住——
 * 面试前一天想不起原始 JD 是很常见的事，而它决定了你该怎么准备。
 */
export function freezeJd({ job, jd, jdUrl, applyUrl, location, deadline } = {}) {
  if (jd && String(jd).trim()) {
    return {
      title: job?.title ?? null,
      company: job?.company_name ?? null,
      source: 'user',
      jdUrl: str(jdUrl, 1000),
      text: String(jd).trim().slice(0, 20000),
      capturedAt: nowIso(),
    }
  }
  if (!job) return null
  return {
    title: job.title ?? null,
    company: job.company_name ?? null,
    source: 'job',
    jobId: job.id,
    location: location ?? job.location ?? null,
    deadline: deadline ?? job.deadline ?? null,
    applyUrl: applyUrl ?? job.apply_url ?? null,
    recruitType: job.recruit_type ?? null,
    description: str(job.description, 20000),
    requirements: str(job.requirements, 20000),
    skills: parseJson(job.skills, []),
    capturedAt: nowIso(),
  }
}

export function mapApplication(row) {
  if (!row) return null
  return {
    ...row,
    archived: toBool(row.archived),
    statusLabel: APPLICATION_LABEL[row.status] ?? row.status,
    submittedJd: parseJson(row.submitted_jd, null),
    submissionSnapshot: parseJson(row.submission_snapshot, null),
  }
}

export class ApplicationRepo {
  constructor(db, log) {
    this.db = db
    this.log = log
  }

  create(input) {
    return this.db.tx(() => {
      const status = APPLICATION_STATUSES.includes(String(input.status)) ? String(input.status) : 'saved'
      const job = input.jobId ? this.db.get('SELECT * FROM job WHERE id = ?', [input.jobId]) : null
      const companyName = str(input.companyName ?? job?.company_name, 200)
      const jobTitle = str(input.jobTitle ?? job?.title, 300)
      if (!companyName || !jobTitle) throw new Error('公司与岗位名称必填（或给出有效 jobId）')
      const at = nowIso()
      const id = uuid()
      const jobUrl = job ? this.db.get('SELECT source_url FROM job_source WHERE job_id = ? ORDER BY retrieved_at DESC LIMIT 1', [job.id])?.source_url : null
      // 上下文字段独立保存，岗位删除后仍能查看；收藏阶段只是草稿，不是已经提交的历史事实。
      const applyUrl = str(input.applyUrl ?? input.url, 1000) ?? job?.apply_url ?? jobUrl
      const location = str(input.location, 200) ?? job?.location ?? null
      const deadline = str(input.deadline, 40) ?? job?.deadline ?? null
      const recruitType = str(input.recruitType, 40) ?? job?.recruit_type ?? null
      const appliedAt = str(input.appliedAt, 40) ?? (stageIndexOf(status) >= 0 ? at.slice(0, 10) : null)
      const submittedJd = freezeJd({ job, jd: input.jd, jdUrl: input.jdUrl, applyUrl, location, deadline })
      const resumeVersionId = str(input.resumeVersionId, 60)
      const docIds = materialIds(input.docIds)
      const submissionSnapshot = buildSubmissionSnapshot({
        ...readMaterials(this.db, resumeVersionId, docIds),
        specified: input.resumeVersionId !== undefined || input.docIds !== undefined,
        note: input.snapshotNote,
        state: appliedAt ? 'submitted' : 'draft',
        capturedAt: at,
      })
      this.db.run(`INSERT INTO application (id, job_id, company_name, job_title, url, apply_url, location, deadline, recruit_type, status, channel, resume_version_id, applied_at, next_action, next_action_at, notes, created_at, updated_at, submitted_jd, submission_snapshot, jd_url)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, str(input.jobId, 60), companyName, jobTitle, str(input.url ?? jobUrl, 1000), applyUrl, location, deadline, recruitType, status,
          str(input.channel, 120), resumeVersionId, appliedAt,
          str(input.nextAction, 500), str(input.nextActionAt, 40), str(input.notes, 8000), at, at,
          submittedJd ? JSON.stringify(submittedJd) : null, JSON.stringify(submissionSnapshot), str(input.jdUrl, 1000)])
      this.db.run('INSERT INTO application_event (id, application_id, type, to_status, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, 'status', status, at, '创建投递记录', at])
      if (submissionSnapshot.frozen) this.recordSubmissionFreeze(id, submissionSnapshot, at)
      return this.get(id)
    })
  }

  recordSubmissionFreeze(id, snapshot, at) {
    this.db.run('INSERT INTO application_event (id, application_id, type, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), id, 'submission_frozen', at, JSON.stringify({ hash: snapshot.hash, resumeVersionId: snapshot.resumeVersionId, docIds: snapshot.documents.map((doc) => doc.id), warnings: snapshot.warnings }), at])
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
    return this.db.tx(() => {
      const current = this.db.get('SELECT * FROM application WHERE id = ?', [id])
      if (!current) throw new Error('投递记录不存在')
      const at = nowIso()
      const nextStatus = patch.status !== undefined && APPLICATION_STATUSES.includes(String(patch.status)) ? String(patch.status) : null
      const previousSnapshot = parseJson(current.submission_snapshot, null)
      const events = this.db.all('SELECT to_status FROM application_event WHERE application_id = ?', [id])
      const alreadySubmitted = submittedBefore(current, events)
      const resumeVersionId = patch.resumeVersionId !== undefined ? str(patch.resumeVersionId, 60) : current.resume_version_id
      const previousDocIds = materialIds((Array.isArray(previousSnapshot?.documents) ? previousSnapshot.documents : []).map((doc) => doc.id))
      const docIds = patch.docIds !== undefined ? materialIds(patch.docIds) : previousDocIds
      if (alreadySubmitted) {
        if ((patch.resumeVersionId !== undefined && resumeVersionId !== current.resume_version_id)
          || (patch.docIds !== undefined && !sameIds(docIds, previousDocIds))
          || (patch.snapshotNote !== undefined && patch.snapshotNote !== previousSnapshot?.note)
          || patch.jd !== undefined || patch.jdUrl !== undefined) {
          throw new Error('已经正式投递，不能覆盖已冻结的简历、资料或 JD；请新建投递记录保存另一份提交材料')
        }
      }
      const fields = {}
      for (const [col, key] of [['next_action', 'nextAction'], ['next_action_at', 'nextActionAt'], ['notes', 'notes'],
        ['channel', 'channel'], ['url', 'url'], ['result', 'result'], ['retro', 'retro'], ['applied_at', 'appliedAt'],
        ['apply_url', 'applyUrl'], ['location', 'location'], ['deadline', 'deadline'], ['recruit_type', 'recruitType'],
        ['company_name', 'companyName'], ['job_title', 'jobTitle']]) {
        if (patch[key] !== undefined) fields[col] = str(patch[key], 8000)
      }
      if (patch.resumeVersionId !== undefined) fields.resume_version_id = resumeVersionId
      if (patch.archived !== undefined) fields.archived = patch.archived ? 1 : 0
      if (nextStatus) fields.status = nextStatus
      const firstSubmit = !alreadySubmitted && (stageIndexOf(nextStatus ?? current.status) >= 0 || Boolean(fields.applied_at))
      let snapshot = null
      if (!alreadySubmitted) {
        const automaticNote = previousSnapshot?.noteSpecified === false
          || previousSnapshot?.note === '创建投递时没有指定提交材料，故只记录了简历版本。'
        const snapshotNote = patch.snapshotNote !== undefined ? patch.snapshotNote : automaticNote ? undefined : previousSnapshot?.note
        // 即便仅修改了状态，或 update(id,{}) 主动刷新，也必须重读同一简历版本此刻的真实内容。
        snapshot = buildSubmissionSnapshot({
          ...readMaterials(this.db, resumeVersionId, docIds),
          specified: patch.resumeVersionId !== undefined || patch.docIds !== undefined || Boolean(previousSnapshot?.materialsSpecified),
          note: snapshotNote,
          state: firstSubmit ? 'submitted' : 'draft', capturedAt: at,
        })
        const job = current.job_id ? this.db.get('SELECT * FROM job WHERE id = ?', [current.job_id]) : null
        const jd = refreshJd({ current, patch, job, at,
          applyUrl: fields.apply_url ?? current.apply_url, location: fields.location ?? current.location, deadline: fields.deadline ?? current.deadline })
        fields.submission_snapshot = JSON.stringify(snapshot)
        fields.submitted_jd = jd ? JSON.stringify(jd) : null
        if (patch.jdUrl !== undefined) fields.jd_url = str(patch.jdUrl, 1000)
        if (firstSubmit && !fields.applied_at) fields.applied_at = at.slice(0, 10)
      }
      // 已投旧版快照只有 id/label 时也不拿今天的简历伪造历史；保留原记录供人工核验。
      if (Object.keys(fields).length) {
        fields.updated_at = at
        this.db.run(`UPDATE application SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
          [...Object.values(fields), id])
      }
      if (firstSubmit) this.recordSubmissionFreeze(id, snapshot, at)
      if (nextStatus && nextStatus !== current.status) {
        this.db.run('INSERT INTO application_event (id, application_id, type, from_status, to_status, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [uuid(), id, 'status', current.status, nextStatus, at, str(patch.note, 2000) ?? `状态 ${current.status} → ${nextStatus}`, at])
      } else if (patch.note) {
        this.db.run('INSERT INTO application_event (id, application_id, type, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [uuid(), id, 'note', at, str(patch.note, 4000), at])
      }
      return this.get(id)
    })
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

  /** 阶段转化率：哪一关在漏人。基于状态历史，而不是只看当前状态。 */
  funnel() {
    const applications = this.db.all('SELECT * FROM application WHERE archived = 0')
    const events = this.db.all('SELECT * FROM application_event')
    return computeFunnel({ applications, events, now: nowIso() })
  }

  /** 同一公司近期是否投过（很多公司有 6 个月冷冻期）。 */
  cooldownCheck({ companyName, months = 6 }) {
    const since = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10)
    const rows = this.db.all(
      `SELECT id, company_name, job_title, status, coalesce(applied_at, created_at) AS at
       FROM application
       WHERE archived = 0 AND company_name LIKE ? AND coalesce(applied_at, created_at) >= ?
       ORDER BY at DESC`,
      [`%${companyName}%`, since],
    )
    return { companyName, months, hits: rows, blocked: rows.length > 0 }
  }
}
