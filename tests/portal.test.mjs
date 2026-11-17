// 校招门户解析 + 抓取留痕/过期/diff + JD 快照。全部离线断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CAMPUS_PORTALS, resolvePortal } from '../host/portal.js'
import {
  STALE_DAYS,
  captureFreshness,
  diffCaptures,
  diffJdSnapshots,
  jdHash,
  scopeKeyOf,
} from '../host/repo/captures.js'
import { makeEnv } from './helpers.mjs'

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString()

describe('campus portal resolution', () => {
  it('matches the company name and common aliases', () => {
    assert.equal(resolvePortal('腾讯')?.name, '腾讯')
    assert.equal(resolvePortal('鹅厂')?.name, '腾讯')
    assert.equal(resolvePortal('Tencent')?.name, '腾讯')
    assert.equal(resolvePortal('字节跳动')?.name, '字节跳动')
    assert.equal(resolvePortal('字节')?.name, '字节跳动')
    assert.equal(resolvePortal('抖音')?.name, '字节跳动')
  })

  it('returns null for a company it does not know instead of guessing a URL', () => {
    assert.equal(resolvePortal('某不知名创业公司'), null)
    assert.equal(resolvePortal(''), null)
  })

  it('every entry ships candidate urls, never a single invented one', () => {
    for (const portal of CAMPUS_PORTALS) {
      assert.ok(Array.isArray(portal.urls) && portal.urls.length >= 1, `${portal.name} needs urls`)
      assert.ok(portal.urls.every((url) => /^https?:\/\//.test(url)), `${portal.name} has a malformed url`)
    }
  })
})

describe('freshness rule', () => {
  it('treats "never captured" as stale', () => {
    const freshness = captureFreshness(null)
    assert.equal(freshness.stale, true)
    assert.equal(freshness.ageDays, null)
    assert.match(freshness.reason, /从未抓取/)
  })

  it('stays fresh inside the threshold and goes stale past it', () => {
    const fresh = captureFreshness(isoDaysAgo(3))
    assert.equal(fresh.stale, false)
    assert.equal(fresh.ageDays, 3)
    const stale = captureFreshness(isoDaysAgo(STALE_DAYS + 1))
    assert.equal(stale.stale, true)
    assert.ok(stale.ageDays >= STALE_DAYS)
    assert.ok(stale.dueAt)
  })

  it('uses a 7 day default threshold', () => {
    assert.equal(STALE_DAYS, 7)
  })
})

describe('scope fingerprint', () => {
  it('ignores ordering so the same filter set compares equal', () => {
    const a = scopeKeyOf({ city: ['北京', '上海'], keyword: '产品', recruitType: 'summer' })
    const b = scopeKeyOf({ city: ['上海', '北京'], keyword: '产品', recruitType: 'summer' })
    assert.equal(a, b)
  })

  it('distinguishes different filter sets and defaults to all', () => {
    assert.equal(scopeKeyOf(null), 'all')
    assert.notEqual(scopeKeyOf({ city: '北京' }), scopeKeyOf({ city: '上海' }))
  })
})

describe('capture diff', () => {
  const row = (code, title, location) => ({ jobCode: code, title, location, companyKey: '字节跳动' })

  it('reports added / removed / unchanged when the scope matches', () => {
    const diff = diffCaptures({
      previous: [row('1', '产品实习生', '北京'), row('2', '运营实习生', '上海')],
      current: [row('2', '运营实习生', '上海'), row('3', '算法实习生', '北京')],
      previousScopeKey: 'all',
      currentScopeKey: 'all',
    })
    assert.equal(diff.added.length, 1)
    assert.equal(diff.added[0].title, '算法实习生')
    assert.equal(diff.removed.length, 1)
    assert.equal(diff.removed[0].title, '产品实习生')
    assert.equal(diff.unchanged, 1)
    assert.equal(diff.scopesComparable, true)
  })

  it('refuses to call a job "closed" when the filter scope changed', () => {
    const diff = diffCaptures({
      previous: [row('1', '产品实习生', '北京'), row('2', '运营实习生', '上海')],
      current: [row('1', '产品实习生', '北京')],
      previousScopeKey: 'all',
      currentScopeKey: 'city=北京',
    })
    assert.equal(diff.scopesComparable, false)
    assert.equal(diff.removed.length, 0, 'narrower scope must not mark jobs as removed')
    assert.equal(diff.vanishedButNotClosed.length, 1)
    assert.match(diff.caveat, /范围不同/)
  })

  it('identifies a job by code when present, by title+location otherwise', () => {
    const withoutCode = [{ title: '产品实习生', location: '北京', companyKey: '字节跳动' }]
    const sameAgain = [{ title: '产品实习生', location: '北京', companyKey: '字节跳动' }]
    const diff = diffCaptures({ previous: withoutCode, current: sameAgain })
    assert.equal(diff.added.length, 0)
    assert.equal(diff.unchanged, 1)
  })
})

describe('JD change detection', () => {
  const base = { jobId: 'j1', title: '产品实习生', location: '北京', deadline: null, description: '负责需求分析', requirements: '本科' }

  it('hashes stably and changes when any field changes', () => {
    assert.equal(jdHash(base), jdHash({ ...base }))
    assert.notEqual(jdHash(base), jdHash({ ...base, requirements: '硕士' }))
    assert.notEqual(jdHash(base), jdHash({ ...base, description: '负责需求分析与增长' }))
  })

  it('names the fields that changed', () => {
    const changes = diffJdSnapshots({
      before: [base],
      after: [{ ...base, requirements: '硕士及以上' }, { jobId: 'j2', title: '新岗位' }],
    })
    assert.equal(changes.length, 1)
    assert.equal(changes[0].jobId, 'j1')
    assert.deepEqual(changes[0].changedFields, ['requirements'])
  })

  it('stays silent when nothing changed', () => {
    assert.deepEqual(diffJdSnapshots({ before: [base], after: [{ ...base }] }), [])
  })
})

describe('capture repo', () => {
  it('records runs, keeps them per scope, and reports history', () => {
    const env = makeEnv()
    try {
      const first = env.repos.captures.record({
        companyKey: '字节跳动', companyName: '字节跳动', sourceUrl: 'https://x/api',
        scope: '全部', scopeKey: 'all', found: 10, created: 10, merged: 0,
      })
      assert.ok(first.id)
      assert.equal(first.found, 10)
      env.repos.captures.record({ companyKey: '字节跳动', companyName: '字节跳动', scope: '城市=北京', scopeKey: 'city=北京', found: 4 })
      env.repos.captures.record({ companyKey: '字节跳动', companyName: '字节跳动', scopeKey: 'all', found: 12 })

      const latestAll = env.repos.captures.latest('字节跳动', 'all')
      assert.equal(latestAll.found, 12, 'latest within the same scope')
      const latestAny = env.repos.captures.latest('字节跳动')
      assert.equal(latestAny.found, 12)
      assert.equal(env.repos.captures.history('字节跳动').length, 3)
      assert.equal(env.repos.captures.latest('不存在的公司'), null)
    } finally {
      env.cleanup()
    }
  })

  it('stores JD snapshots and reads the latest per job back', () => {
    const env = makeEnv()
    try {
      const saved = env.repos.captures.saveJdSnapshots([
        { jobId: 'j1', companyKey: '字节跳动', title: '产品实习生', location: '北京', description: '旧 JD', requirements: '本科' },
        { jobId: 'j2', companyKey: '字节跳动', title: '运营实习生', location: '上海', description: 'JD2', requirements: '本科' },
      ])
      assert.equal(saved.saved, 2)
      const previous = env.repos.captures.previousJdSnapshots('字节跳动')
      assert.equal(previous.length, 2)
      const j1 = previous.find((row) => row.jobId === 'j1')
      assert.equal(j1.description, '旧 JD')
    } finally {
      env.cleanup()
    }
  })

  it('records the set of job codes each run saw, so the next diff has a correct baseline', () => {
    const env = makeEnv()
    try {
      env.repos.captures.record({
        companyKey: '腾讯', companyName: '腾讯', scope: '招聘类型=实习生', scopeKey: '招聘类型=实习生',
        found: 2, seenCodes: ['21417', '21415', '21417'],
      })
      const latest = env.repos.captures.latest('腾讯', '招聘类型=实习生')
      assert.deepEqual(latest.seenCodes, ['21417', '21415'], 'deduped and stored')
      // 别的范围看不到这批的基线，这正是「不能拿整个公司岗位库当基准」的原因
      assert.equal(env.repos.captures.latest('腾讯', 'all'), null)

      env.repos.captures.record({ companyKey: '腾讯', companyName: '腾讯', scopeKey: 'all', found: 6 })
      assert.equal(env.repos.captures.latest('腾讯', 'all').seenCodes, null, 'old-style run without codes stays null')
    } finally {
      env.cleanup()
    }
  })

  it('maps captured job codes back to stored job ids', () => {
    const env = makeEnv()
    try {
      const imported = env.repos.jobs.importPostings([
        { company: '字节跳动', title: 'Agent开发实习生', jobCode: '7707589374913759541', location: '北京' },
        { company: '字节跳动', title: '产品经理实习生', jobCode: '7707589374913759542', location: '上海' },
      ], { company: '字节跳动', pageUrl: 'https://jobs.bytedance.com/api', official: false })
      assert.equal(imported.created.length, 2, 'list postings sharing one pageUrl must not merge into one')
      assert.equal(imported.merged.length, 0)

      const map = env.repos.captures.jobIdByCode('字节跳动', ['7707589374913759541', '不存在'])
      assert.equal(map.size, 1)
      assert.ok(map.get('7707589374913759541'))

      const current = env.repos.captures.currentJobs('字节跳动', '字节跳动')
      assert.equal(current.length, 2)
    } finally {
      env.cleanup()
    }
  })
})
