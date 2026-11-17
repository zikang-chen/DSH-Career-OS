import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { register } from "node:module"
import { extractReportedTotal } from "../host/crawl.js"
import { assessCaptureCompleteness, diffCaptures } from "../host/repo/captures.js"
import { companyKey } from "../host/util.js"
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

describe("capture completeness gate", () => {
  const full = (count) => assessCaptureCompleteness({ reportedTotal: count, extractedCount: count, batchCount: count, observedCount: count, evidenceKind: "api-json" })
  const unclosed = (currentCompleteness, previousCompleteness = full(2)) => diffCaptures({
    previous: [{ jobCode: "1" }, { jobCode: "2" }], current: [{ jobCode: "1" }],
    previousScopeKey: "all", currentScopeKey: "all", previousCompleteness, currentCompleteness,
  })

  it("only certifies matching API totals and successful untruncated observations", () => {
    assert.equal(full(2).isComplete, true)
    assert.deepEqual(full(2).parseWarnings, [])
    assert.equal(full(0).isComplete, true, "a verified empty full API response is valid")
    const diff = unclosed(full(1))
    assert.equal(diff.removed.length, 1)
    assert.deepEqual(diff.vanishedButNotClosed, [])
    assert.equal(diff.reason, null)
  })

  it("does not mistake a partially fetched page for a complete list", () => {
    const page = assessCaptureCompleteness({ reportedTotal: 100, extractedCount: 1, batchCount: 1, observedCount: 1, evidenceKind: "api-json" })
    assert.equal(page.isComplete, false)
    assert.match(page.reason, /分页|遗漏/)
    const diff = unclosed(page)
    assert.equal(diff.removed.length, 0)
    assert.equal(diff.vanishedButNotClosed.length, 1)
    assert.match(diff.reason, /本次抓取完整性未通过/)
  })

  it("uses actual post-limit observations even when all API rows were initially parsed", () => {
    const limited = assessCaptureCompleteness({ reportedTotal: 2, extractedCount: 2, batchCount: 1, observedCount: 1, evidenceKind: "api-json" })
    assert.equal(limited.observed, 1)
    assert.equal(limited.isComplete, false)
    assert.equal(limited.limitTruncated, true)
    assert.match(limited.reason, /limit 截断/)
    assert.equal(unclosed(limited).removed.length, 0)
    assert.equal(unclosed(limited).vanishedButNotClosed.length, 1)
  })

  it("rejects failed imports, omitted parser rows and duplicate merges", () => {
    const failed = assessCaptureCompleteness({ reportedTotal: 2, extractedCount: 2, batchCount: 2, observedCount: 1, failedCount: 1, evidenceKind: "api-json" })
    assert.equal(failed.isComplete, false)
    assert.match(failed.reason, /入库失败/)
    assert.equal(unclosed(failed).removed.length, 0)
    assert.equal(unclosed(full(1), failed).removed.length, 0, "an incomplete previous baseline is not sufficient either")
    const omitted = assessCaptureCompleteness({ reportedTotal: 1, extractedCount: 2, batchCount: 2, observedCount: 1, evidenceKind: "api-json" })
    assert.equal(omitted.isComplete, false, "matching total alone must not conceal discarded rows")
    assert.match(omitted.reason, /遗漏或合并/)
    const warning = assessCaptureCompleteness({ reportedTotal: 1, extractedCount: 1, batchCount: 1, observedCount: 1, parseWarnings: ["岗位编号缺失"], evidenceKind: "api-json" })
    assert.equal(warning.isComplete, false)
    assert.equal(unclosed(warning).removed.length, 0)
  })

  it("does not certify unknown totals or screenshot/list-text counts", () => {
    for (const reportedTotal of [null, undefined, "2", NaN, -1, 1.5]) {
      const unknown = assessCaptureCompleteness({ reportedTotal, extractedCount: 1, batchCount: 1, observedCount: 1, evidenceKind: "api-json" })
      assert.equal(unknown.isComplete, null)
      assert.equal(unclosed(unknown).removed.length, 0)
      assert.match(unknown.reason, /完整性未知/)
    }
    for (const evidenceKind of [undefined, "screenshot", "list-text", "dom-text"]) {
      const visible = assessCaptureCompleteness({ reportedTotal: 1, extractedCount: 1, batchCount: 1, observedCount: 1, evidenceKind })
      assert.equal(visible.isComplete, null)
      assert.equal(unclosed(visible).removed.length, 0)
      assert.match(visible.reason, /截图、列表文本/)
    }
  })

  it("does not certify surplus observations or invalid counts", () => {
    const surplus = assessCaptureCompleteness({ reportedTotal: 1, extractedCount: 2, batchCount: 2, observedCount: 2, evidenceKind: "api-json" })
    assert.equal(surplus.isComplete, false, "greater-than-total is not evidence of a correct parse")
    assert.equal(assessCaptureCompleteness({ reportedTotal: 1, observedCount: 1, evidenceKind: "api-json" }).isComplete, false)
  })
})

describe("browser capture handler completeness (offline)", () => {
  let registerCareerTools
  let browserFixture
  before(async () => {
    // Mock only this tool module's browser dependency; no real browser, network or personal DB.
    const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
      let payload;
      export const setPayload = value => { payload = value };
      export const capturePageJson = async () => ({ ok: true, captured: { url: 'https://jobs.example.test/api/jobs', json: payload }, candidates: [] });
      export const browserProfileDir = () => '';
      export const findBrowserExecutable = () => null;
      export const closeBrowser = async () => { throw new Error('real browser forbidden in test') };
      export const openForLogin = closeBrowser;
    `)}`
    const loaderUrl = `data:text/javascript,${encodeURIComponent(`
      let settings;
      export function initialize(data) { settings = data }
      export function resolve(specifier, context, nextResolve) {
        if (context.parentURL === settings.toolsUrl && specifier === './browser.js') return { url: settings.fixtureUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `)}`
    register(loaderUrl, { parentURL: import.meta.url, data: { toolsUrl: new URL("../host/tools.js", import.meta.url).href, fixtureUrl } })
    browserFixture = await import(fixtureUrl)
    ;({ registerCareerTools } = await import("../host/tools.js"))
  })

  const fixtureJobs = [
    { jobName: "数据分析实习生", city: "北京", jobId: "9001", url: "/position/9001" },
    { jobName: "产品经理实习生", city: "上海", jobId: "9002", url: "/position/9002" },
  ]
  const captureTool = (env) => {
    const tools = new Map()
    registerCareerTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, {
      repos: env.repos, config: { dataDir: env.dir }, monitor: {}, panel: { publish() {} }, logger: env.logger,
    })
    return async (payload, args = {}) => {
      browserFixture.setPayload(payload)
      return JSON.parse(await tools.get("career_browser_capture").execute({ url: "https://jobs.example.test/jobs", company: "示例科技", scope: "all", fillJd: false, ...args }))
    }
  }

  it("persists post-limit successful count and never reports truncated jobs as removed", async () => {
    const env = makeEnv()
    try {
      const capture = captureTool(env)
      const payload = { data: { total: 2, list: fixtureJobs } }
      assert.equal((await capture(payload)).completeness.isComplete, true)
      const limited = await capture(payload, { limit: 1 })
      assert.equal(limited.found, 2)
      assert.equal(limited.completeness.observed, 1)
      assert.equal(limited.completeness.isComplete, false)
      assert.equal(limited.diff.removedCount, 0)
      assert.equal(limited.diff.vanishedButNotClosedCount, 1)
      assert.match(limited.diff.reason, /limit 截断/)
      assert.match(limited.next, /不能判下架/)
      const saved = env.repos.captures.latest(companyKey("示例科技"), "all")
      assert.equal(saved.observed_count, 1)
      assert.equal(saved.isComplete, false)
      assert.deepEqual(saved.seenCodes, ["9001"])
      assert.equal(saved.stats.completeness.limitTruncated, true)
    } finally { env.cleanup() }
  })

  it("does not close unobserved jobs on a partial API page or parser omission", async () => {
    const env = makeEnv()
    try {
      const capture = captureTool(env)
      for (const list of [fixtureJobs.slice(0, 1), [fixtureJobs[0], { jobId: "9002", city: "上海" }]]) {
        await capture({ data: { total: 2, list: fixtureJobs } })
        const partial = await capture({ data: { total: 2, list } })
        assert.equal(partial.completeness.observed, 1)
        assert.equal(partial.completeness.isComplete, false)
        assert.equal(partial.diff.removedCount, 0)
        assert.equal(partial.diff.vanishedButNotClosedCount, 1)
        assert.match(partial.diff.reason, /分页或解析有遗漏/)
      }
    } finally { env.cleanup() }
  })

  it("passes import failures to the gate instead of counting failed rows as observed", async () => {
    const env = makeEnv()
    try {
      const capture = captureTool(env)
      const payload = { data: { total: 2, list: fixtureJobs } }
      await capture(payload)
      const upsert = env.repos.jobs.upsertJob.bind(env.repos.jobs)
      env.repos.jobs.upsertJob = (posting, options) => {
        if (posting.jobCode === "9002") throw new Error("offline fixture import failure")
        return upsert(posting, options)
      }
      const failed = await capture(payload)
      assert.equal(failed.failed.length, 1)
      assert.equal(failed.completeness.observed, 1)
      assert.equal(failed.completeness.failedCount, 1)
      assert.equal(failed.completeness.isComplete, false)
      assert.equal(failed.diff.removedCount, 0)
      assert.equal(failed.diff.vanishedButNotClosedCount, 1)
      const saved = env.repos.captures.latest(companyKey("示例科技"), "all")
      assert.equal(saved.observed_count, 1)
      assert.deepEqual(saved.seenCodes, ["9001"])
      assert.ok(saved.parseWarnings.some((warning) => warning.includes("offline fixture import failure")))
    } finally { env.cleanup() }
  })

  it("does not close jobs after an unknown-total capture or a legacy unverified baseline", async () => {
    const env = makeEnv()
    try {
      const capture = captureTool(env)
      await capture({ data: { total: 2, list: fixtureJobs } })
      const unknown = await capture({ data: { list: fixtureJobs.slice(0, 1) } })
      assert.equal(unknown.completeness.isComplete, null)
      assert.equal(unknown.diff.removedCount, 0)
      assert.equal(unknown.diff.vanishedButNotClosedCount, 1)
      env.repos.captures.record({ companyKey: companyKey("示例科技"), companyName: "示例科技", scopeKey: "all", found: 2, seenCodes: ["9001", "9002"], reportedTotal: 2, observedCount: 2, isComplete: true })
      const legacy = await capture({ data: { total: 1, list: fixtureJobs.slice(0, 1) } })
      assert.equal(legacy.completeness.isComplete, true)
      assert.equal(legacy.diff.removedCount, 0)
      assert.equal(legacy.diff.vanishedButNotClosedCount, 1)
      assert.match(legacy.diff.reason, /上次抓取完整性未知/)
    } finally { env.cleanup() }
  })

  it("reports removals when both actual captures are certified complete", async () => {
    const env = makeEnv()
    try {
      const capture = captureTool(env)
      await capture({ data: { total: 2, list: fixtureJobs } })
      const full = await capture({ data: { total: 1, list: fixtureJobs.slice(0, 1) } })
      assert.equal(full.completeness.isComplete, true)
      assert.equal(full.diff.removedCount, 1)
      assert.equal(full.diff.removed[0].jobCode, "9002")
      assert.equal(full.diff.vanishedButNotClosedCount, 0)
      assert.equal(full.diff.reason, null)
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
      assert.equal(env.repos.captures.latest("字节跳动").isComplete, false)
      const full = env.repos.captures.record({ companyKey: "字节跳动", companyName: "字节跳动", found: 5, reportedTotal: 5, observedCount: 5, isComplete: true })
      assert.equal(full.isComplete, true)
      assert.equal(env.repos.captures.latest("字节跳动").isComplete, true)
      const unknown = env.repos.captures.record({ companyKey: "字节跳动", companyName: "字节跳动", found: 3 })
      assert.equal(unknown.isComplete, null, "no total => unknown, not a guess")
      assert.equal(env.repos.captures.latest("字节跳动").isComplete, null)
    } finally { env.cleanup() }
  })

  it("round-trips parsing completeness and warnings through latest for the next diff", () => {
    const env = makeEnv()
    try {
      const completeness = env.repos.captures.assessCompleteness({ reportedTotal: 2, extractedCount: 2, batchCount: 2, observedCount: 1, failedCount: 1, parseWarnings: ["第二条入库失败"], evidenceKind: "api-json" })
      const saved = env.repos.captures.record({
        companyKey: "字节跳动", companyName: "字节跳动", scopeKey: "all", found: 2,
        seenCodes: ["1"], reportedTotal: 2, observedCount: completeness.observed,
        isComplete: completeness.isComplete, parseWarnings: completeness.parseWarnings, stats: { completeness },
      })
      const latest = env.repos.captures.latest("字节跳动", "all")
      assert.equal(latest.id, saved.id)
      assert.equal(latest.observed_count, 1, "successful observations, not raw API rows")
      assert.equal(latest.isComplete, false)
      assert.deepEqual(latest.parseWarnings, completeness.parseWarnings)
      assert.deepEqual(latest.stats.completeness, completeness)
      const diff = diffCaptures({ previous: [{ jobCode: "1" }], current: [], previousCompleteness: latest.stats.completeness, currentCompleteness: true })
      assert.equal(diff.removed.length, 0)
      assert.equal(diff.vanishedButNotClosed.length, 1)
    } finally { env.cleanup() }
  })
})
