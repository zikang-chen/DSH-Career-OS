// 自动备份：planning 纯函数 + 落盘。离线可测。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { backupsDir, dueForBackup, listBackups, planRetention, runBackup } from '../host/backup.js'

describe('backup planning', () => {
  it('is due when never backed up or interval elapsed', () => {
    assert.equal(dueForBackup(null), true)
    const now = '2026-11-17T12:00:00.000Z'
    assert.equal(dueForBackup('2026-11-17T11:00:00.000Z', { now, intervalHours: 20 }), false)
    assert.equal(dueForBackup('2026-11-16T01:00:00.000Z', { now, intervalHours: 20 }), true)
  })

  it('keeps only the newest N', () => {
    const files = ['career-1.db', 'career-2.db', 'career-3.db']
    assert.deepEqual(planRetention(files, 2), ['career-1.db'])
    assert.deepEqual(planRetention(files, 5), [])
  })
})

describe('backup execution', () => {
  it('creates one backup, then skips within the interval, and prunes old ones', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'careeros-bk-'))
    const created = []
    const db = { backupTo: (target) => { created.push(target); fs.writeFileSync(target, 'x') } }
    try {
      const first = runBackup({ db, dataDir, now: '2026-11-17T00:00:00.000Z', retain: 2 })
      assert.equal(first.ok, true)
      assert.ok(first.created)
      assert.equal(listBackups(backupsDir(dataDir)).length, 1)

      // 同日再跑应跳过
      const second = runBackup({ db, dataDir, now: '2026-11-17T02:00:00.000Z' })
      assert.equal(second.skipped, true)

      // 跨过间隔后再跑，且超过 retain 会删旧的
      const third = runBackup({ db, dataDir, now: '2026-11-18T02:00:00.000Z', retain: 1 })
      assert.equal(third.ok, true)
      assert.equal(listBackups(backupsDir(dataDir)).length, 1, 'retain=1 keeps only newest')
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('reports failure instead of throwing', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'careeros-bk2-'))
    try {
      const result = runBackup({ db: { backupTo: () => { throw new Error('disk full') } }, dataDir })
      assert.equal(result.ok, false)
      assert.match(result.error, /disk full/)
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
