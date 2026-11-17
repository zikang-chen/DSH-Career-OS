// Shared test harness: a throw-away database + repositories per test file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CareerDb } from '../host/db.js'
import { Repos } from '../host/repo/index.js'

export function silentLogger() {
  const lines = []
  const push = (level) => (msg, extra) => lines.push({ level, msg, extra })
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

export function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careeros-test-'))
  const logger = silentLogger()
  const db = new CareerDb(path.join(dir, 'career.db'), logger).open()
  const repos = new Repos(db, logger)
  return {
    dir,
    db,
    repos,
    logger,
    cleanup() {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const sampleProfile = () => ({
  display_name: '测试同学',
  school: '示例大学',
  degree: '本科',
  major: '计算机科学与技术',
  grad_year: 2027,
  weekly_days: 4,
  availability_start: '2026-12-01',
  cities: ['北京', '上海'],
  remote_pref: 'hybrid',
  internship_types: ['daily', 'summer'],
  target_industries: ['互联网', '人工智能'],
  target_roles: ['产品经理', '数据分析'],
  skills: [{ name: 'Python', verified: true }, { name: 'SQL', verified: true }, { name: '数据分析', verified: true }],
  excluded: ['销售'],
})
