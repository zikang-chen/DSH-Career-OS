// Export, backup and destructive operations. Destructive ones always require an
// explicit confirmation token so an agent cannot wipe data by accident.
import fs from 'node:fs'
import path from 'node:path'
import { nowIso } from './util.js'

export class Exporter {
  constructor({ db, repos, config, logger }) {
    this.db = db
    this.repos = repos
    this.config = config
    this.logger = logger
    this.exportDir = path.join(config.dataDir, 'exports')
  }

  collect(scope) {
    const s = String(scope ?? 'all')
    const pick = (...names) => Object.fromEntries(names.map((n) => [n, true]))
    void pick
    const out = { exportedAt: nowIso(), scope: s, schemaVersion: this.db.version }
    const wants = (name) => s === 'all' || s === name
    if (wants('profile')) {
      out.profile = this.repos.profile.get()
      out.resumeVersions = this.repos.profile.listResumes()
      out.skills = this.repos.profile.listSkills()
    }
    if (wants('jobs')) {
      out.jobs = this.db.all('SELECT * FROM job ORDER BY created_at')
      out.jobSources = this.db.all('SELECT * FROM job_source')
      out.jobStatusHistory = this.db.all('SELECT * FROM job_status_history ORDER BY verified_at')
      out.companies = this.db.all('SELECT * FROM company')
      out.industries = this.db.all('SELECT * FROM industry')
    }
    if (wants('applications')) {
      out.applications = this.db.all('SELECT * FROM application')
      out.applicationEvents = this.db.all('SELECT * FROM application_event')
    }
    if (wants('research')) {
      out.researchReports = this.db.all('SELECT * FROM research_report')
      out.forumPosts = this.db.all('SELECT * FROM forum_post')
      out.forumClaims = this.db.all('SELECT * FROM forum_claim')
      out.interviewExperiences = this.db.all('SELECT * FROM interview_experience')
      out.hiringRequirements = this.db.all('SELECT * FROM hiring_requirement')
      out.evidence = this.db.all('SELECT * FROM evidence')
    }
    out.monitoring = {
      rules: this.db.all('SELECT * FROM monitoring_rule'),
      notifications: this.db.all('SELECT * FROM notification'),
      syncRuns: this.db.all('SELECT * FROM sync_run ORDER BY started_at DESC LIMIT 200'),
      sourceHealth: this.db.all('SELECT * FROM source_health'),
    }
    out.feedback = this.db.all('SELECT * FROM feedback')
    return out
  }

  exportData(scope = 'all') {
    fs.mkdirSync(this.exportDir, { recursive: true })
    const data = this.collect(scope)
    const stamp = nowIso().replace(/[:.]/g, '-')
    const file = path.join(this.exportDir, `career-export-${scope}-${stamp}.json`)
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    const counts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]))
    return { file, bytes: fs.statSync(file).size, counts, scope: data.scope }
  }

  /** Write a CSV export next to the JSON exports and return its path. */
  writeCsv(name, csv) {
    const dir = path.join(this.config.dataDir, 'exports')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = nowIso().replace(/[:.]/g, '-')
    const file = path.join(dir, `${name}-${stamp}.csv`)
    fs.writeFileSync(file, csv, 'utf8')
    return file
  }

  backupDatabase() {
    fs.mkdirSync(path.join(this.config.dataDir, 'backups'), { recursive: true })
    const stamp = nowIso().replace(/[:.]/g, '-')
    const target = path.join(this.config.dataDir, 'backups', `career-${stamp}.db`)
    this.db.backupTo(target)
    const json = this.exportData('all')
    return { database: target, json: json.file, bytes: fs.statSync(target).size }
  }

  /** Two-step delete: `prepare` returns a token, `commit` must echo it. */
  prepareDelete(scope = 'all') {
    const token = `delete-${Date.now().toString(36)}`
    this.pendingDelete = { token, scope, at: Date.now() }
    const counts = {}
    for (const t of ['job', 'application', 'forum_post', 'forum_claim', 'company', 'resume_version', 'notification', 'research_report']) {
      try {
        counts[t] = Number(this.db.scalar(`SELECT count(*) FROM ${t}`) ?? 0)
      } catch {
        counts[t] = 0
      }
    }
    return { token, scope, counts, warning: '这是不可撤销操作。先 career_export 备份，再让用户确认 token。' }
  }

  commitDelete(token) {
    const pending = this.pendingDelete
    if (!pending || pending.token !== token) throw new Error('确认 token 不匹配或已过期，请重新 prepare')
    if (Date.now() - pending.at > 10 * 60 * 1000) throw new Error('确认 token 已过期（10 分钟）')
    const scope = pending.scope
    const tables = scope === 'all'
      ? ['job_source', 'job_status_history', 'job_note', 'match_result', 'job', 'application_event', 'application',
        'forum_claim', 'forum_post', 'interview_experience', 'hiring_requirement', 'research_report', 'evidence',
        'notification', 'monitoring_rule', 'sync_run', 'feedback', 'company_watch', 'company', 'industry', 'skill', 'resume_version']
      : []
    if (!tables.length) throw new Error(`不支持的删除范围：${scope}（仅支持 all）`)
    this.db.tx(() => {
      for (const t of tables) {
        try {
          this.db.run(`DELETE FROM ${t}`)
        } catch (err) {
          this.logger.warn('delete skipped', { table: t, error: String(err?.message ?? err) })
        }
      }
    })
    this.pendingDelete = null
    return { deleted: tables.length, scope }
  }

  cleanupOldExports(keep = 20) {
    if (!fs.existsSync(this.exportDir)) return 0
    const files = fs.readdirSync(this.exportDir)
      .filter((f) => f.startsWith('career-export-'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(this.exportDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    let removed = 0
    for (const entry of files.slice(keep)) {
      fs.rmSync(path.join(this.exportDir, entry.f), { force: true })
      removed += 1
    }
    return removed
  }
}
