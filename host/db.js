// SQLite access layer on top of the runtime's built-in `node:sqlite` (no native
// module, no install step). Provides versioned migrations, a tiny query facade and
// transactional helpers.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS, SCHEMA_VERSION, UNICODE_FTS_MIGRATION } from './schema.js'
import { bindAll, nowIso } from './util.js'

export class CareerDb {
  /**
   * @param {string} file absolute path of the database file
   * @param {{info:Function,warn:Function,error:Function}} logger
   */
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.db = null
    this.ftsMode = 'unknown'
    this.depth = 0
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.migrate()
    return this
  }

  get opened() {
    return this.db !== null
  }

  /** Close idempotently; WAL checkpoints on close so backups are self-contained. */
  close() {
    if (!this.db) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* checkpoint is best-effort */
    }
    try {
      this.db.close()
    } finally {
      this.db = null
    }
  }

  appliedVersions() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`)
    return new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)))
  }

  migrate() {
    const applied = this.appliedVersions()
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        if (migration.version === 2) this.ftsMode = this.detectFtsMode()
        continue
      }
      let plan = migration
      if (migration.version === 2) {
        this.ftsMode = 'trigram'
        try {
          this.execMigration(migration)
        } catch (err) {
          // Older SQLite builds have no trigram tokenizer: retry with unicode61 and
          // remember that CJK search must fall back to LIKE.
          this.logger.warn('FTS5 trigram unavailable, falling back to unicode61', { error: String(err?.message ?? err) })
          this.ftsMode = 'unicode61'
          plan = UNICODE_FTS_MIGRATION
        }
      } else {
        this.execMigration(migration)
      }
      // execMigration records the version inside the same transaction.
      this.logger.info('migration applied', { version: migration.version, name: plan.name })
    }
    this.version = Number(this.db.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v ?? 0)
    if (this.version > SCHEMA_VERSION) {
      this.logger.warn('database schema is newer than this plugin build', { db: this.version, plugin: SCHEMA_VERSION })
    }
    if (this.ftsMode === 'unknown') this.ftsMode = this.detectFtsMode()
    return this.version
  }

  execMigration(migration) {
    this.db.exec('BEGIN')
    try {
      this.db.exec(migration.sql)
      this.db.exec(`INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name.replace(/'/g, "''")}', '${nowIso()}')`)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the failing statement may already have ended the transaction */
      }
      throw err
    }
  }

  /** `trigram` supports CJK substring MATCH; anything else needs the LIKE fallback. */
  detectFtsMode() {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_fts'")
        .get()
      const sql = String(row?.sql ?? '')
      if (sql.includes('trigram')) return 'trigram'
      return sql ? 'unicode61' : 'missing'
    } catch {
      return 'missing'
    }
  }

  require() {
    if (!this.db) throw new Error('database is not open')
    return this.db
  }

  all(sql, params = []) {
    return this.require().prepare(sql).all(...bindAll(params))
  }

  get(sql, params = []) {
    const row = this.require().prepare(sql).get(...bindAll(params))
    return row === undefined ? undefined : row
  }

  run(sql, params = []) {
    const res = this.require().prepare(sql).run(...bindAll(params))
    return { changes: Number(res.changes ?? 0), lastInsertRowid: res.lastInsertRowid }
  }

  scalar(sql, params = []) {
    const row = this.get(sql, params)
    if (!row) return null
    const keys = Object.keys(row)
    return keys.length ? row[keys[0]] : null
  }

  /** Nested transactions become no-ops, so helpers can compose safely. */
  tx(fn) {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth += 1
    try {
      const out = fn()
      this.depth -= 1
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.depth -= 1
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /** Counter used by the data-source health panel. */
  bump(table, id, column, by = 1) {
    this.run(`UPDATE ${table} SET ${column} = coalesce(${column},0) + ? WHERE id = ?`, [by, id])
  }

  info() {
    const counts = {}
    for (const t of ['job', 'job_source', 'company', 'application', 'forum_post', 'forum_claim', 'notification', 'resume_version', 'research_report']) {
      try {
        counts[t] = Number(this.scalar(`SELECT count(*) FROM ${t}`) ?? 0)
      } catch {
        counts[t] = null
      }
    }
    return {
      file: this.file,
      sizeBytes: safeSize(this.file),
      schemaVersion: this.version ?? null,
      ftsMode: this.ftsMode,
      counts,
    }
  }

  /** Copy the database (and let the caller copy WAL) to a timestamped backup. */
  backupTo(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.rmSync(target, { force: true })
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    return target
  }
}

function safeSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}
