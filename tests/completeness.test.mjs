import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { extractReportedTotal } from "../host/crawl.js"
import { makeEnv } from "./helpers.mjs"

describe("reported total extraction", () => {
  it("finds the total in common envelopes", () => {
    assert.equal(extractReportedTotal({ data: { count: 6559 } }), 6559)
    assert.equal(extractReportedTotal({ data: { positionList: [], count: 999 } }), 999)
    assert.equal(extractReportedTotal({ total: 12 }), 12)
    assert.equal(extractReportedTotal({ data: { total: 3 } }), 3)
  })
  it("returns null rather than guessing", () => {
    assert.equal(extractReportedTotal({ data: { list: [] } }), null)
    assert.equal(extractReportedTotal(null), null)
    assert.equal(extractReportedTotal({ data: { count: "abc" } }), null)
  })
})

describe("job list pagination", () => {
  it("honours offset so successive pages do not repeat", () => {
    const env = makeEnv()
    try {
      for (let i = 0; i < 5; i += 1) {
        env.repos.jobs.importPostings([{ company: "字节跳动", title: `岗位${i}`, jobCode: `1000${i}`, location: "北京" }], { company: "字节跳动", pageUrl: "https://x/api", official: false })
      }
      const all = env.repos.jobs.listJobs({ limit: 10, offset: 0 })
      assert.equal(all.length, 5)
      const page1 = env.repos.jobs.listJobs({ limit: 2, offset: 0 })
      const page2 = env.repos.jobs.listJobs({ limit: 2, offset: 2 })
      assert.equal(page1.length, 2)
      assert.equal(page2.length, 2)
      assert.equal(new Set([...page1, ...page2].map((j) => j.id)).size, 4, "no overlap between pages")
    } finally { env.cleanup() }
  })
})

describe("capture completeness record", () => {
  it("stores reported total vs observed and flags incompleteness", () => {
    const env = makeEnv()
    try {
      const rec = env.repos.captures.record({ companyKey: "字节跳动", companyName: "字节跳动", found: 10, seenCodes: ["1"], reportedTotal: 6559, observedCount: 10, isComplete: false })
      assert.equal(rec.reported_total, 6559)
      assert.equal(rec.isComplete, false)
      const full = env.repos.captures.record({ companyKey: "字节跳动", companyName: "字节跳动", found: 5, reportedTotal: 5, observedCount: 5, isComplete: true })
      assert.equal(full.isComplete, true)
      const unknown = env.repos.captures.record({ companyKey: "字节跳动", companyName: "字节跳动", found: 3 })
      assert.equal(unknown.isComplete, null, "no total => unknown, not a guess")
    } finally { env.cleanup() }
  })
})
