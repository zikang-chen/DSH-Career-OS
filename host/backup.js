// 自动备份：本地数据的最后一道保险。
//
// 设计：
//   - 每天最多备份一次（间隔默认 20 小时），避免频繁 VACUUM；
//   - 只保留最近 N 份（默认 7），不会无限增长；
//   - 失败不影响主流程（调用方 try/catch）；
//   - 纯 planning 函数可离线测试，落盘部分单独一层。
import fs from 'node:fs'
import path from 'node:path'

const NAME_RE = /^career-\d{8}-\d{6}\.db$/

export function backupsDir(dataDir) {
  return path.join(dataDir, 'backups')
}

/** 列出已有备份文件名（升序，最旧在前）。 */
export function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => NAME_RE.test(name)).sort()
  } catch {
    return []
  }
}

/** 距上次备份是否已超过间隔。lastAt 为 ISO 或 null。 */
export function dueForBackup(lastAt, { now = new Date().toISOString(), intervalHours = 20 } = {}) {
  if (!lastAt) return true
  const diff = new Date(now).getTime() - new Date(lastAt).getTime()
  if (Number.isNaN(diff)) return true
  return diff >= intervalHours * 3600 * 1000
}

/** 从已存在文件名推断最近一次备份时间（取最后一个）。 */
export function lastBackupAt(dir) {
  const files = listBackups(dir)
  if (!files.length) return null
  const name = files[files.length - 1]
  const m = /^career-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`
}

/** 需要删除的旧备份（保留最近 retain 份）。 */
export function planRetention(files, retain = 7) {
  if (files.length <= retain) return []
  return files.slice(0, files.length - retain)
}

function stamp(nowIso) {
  const d = new Date(nowIso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/**
 * 执行一次「按需」备份。
 * @returns {{ok:boolean, skipped?:boolean, created?:string, deleted?:string[], error?:string}}
 */
export function runBackup({ db, dataDir, now = new Date().toISOString(), retain = 7, intervalHours = 20, logger } = {}) {
  if (!db?.backupTo) return { ok: false, error: 'db 不支持 backupTo' }
  const dir = backupsDir(dataDir)
  if (!dueForBackup(lastBackupAt(dir), { now, intervalHours })) {
    return { ok: true, skipped: true, reason: `距上次备份不足 ${intervalHours} 小时` }
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `career-${stamp(now)}.db`)
    db.backupTo(target)
    const files = listBackups(dir)
    const stale = planRetention(files, retain)
    for (const name of stale) {
      try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* ignore */ }
    }
    logger?.info?.('backup created', { target, deleted: stale.length })
    return { ok: true, created: target, deleted: stale }
  } catch (err) {
    logger?.warn?.('backup failed', { error: String(err?.message ?? err) })
    return { ok: false, error: String(err?.message ?? err) }
  }
}
