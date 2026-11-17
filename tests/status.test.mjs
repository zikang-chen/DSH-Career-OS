// 招聘状态语义：抓取/重放默认不得冒充「官方在招」。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeEnv } from './helpers.mjs'

const postings = [{ company: '某某公司', title: '产品实习生', jobCode: '9001', location: '北京' }]

describe('status semantics on import', () => {
  it('non-official import yields UNVERIFIED, not OPEN', () => {
    const env = makeEnv()
    try {
      env.repos.jobs.importPostings(postings, { company: '某某公司', pageUrl: 'https://x/api', official: false })
      const job = env.repos.jobs.listJobs({ limit: 10 })[0]
      assert.equal(job.status, 'UNVERIFIED')
    } finally { env.cleanup() }
  })

  it('explicit official import may be OPEN', () => {
    const env = makeEnv()
    try {
      env.repos.jobs.importPostings(postings, { company: '某某公司', pageUrl: 'https://x/campus', official: true })
      const job = env.repos.jobs.listJobs({ limit: 10 })[0]
      assert.equal(job.status, 'OPEN')
    } finally { env.cleanup() }
  })
})
