import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { envelope, failure, flat } from "../host/envelope.js"

describe("response envelope", () => {
  it("wraps data with warnings and next_actions", () => {
    const e = envelope({ a: 1 }, { warnings: ["w", null], nextActions: ["do x"], meta: { tool: "t" } })
    assert.equal(e.ok, true)
    assert.deepEqual(e.data, { a: 1 })
    assert.deepEqual(e.warnings, ["w"])
    assert.deepEqual(e.next_actions, ["do x"])
    assert.equal(e.meta.tool, "t")
  })
  it("failure keeps ok=false and an error string", () => {
    const f = failure(new Error("boom"))
    assert.equal(f.ok, false)
    assert.match(f.error, /boom/)
  })
  it("flat merges envelope with legacy flat fields without losing either", () => {
    const merged = flat(envelope({ x: 1 }, { warnings: ["w"] }), { ok: true, count: 3, x: 1 })
    assert.equal(merged.ok, true)
    assert.equal(merged.count, 3)
    assert.deepEqual(merged.warnings, ["w"])
    assert.deepEqual(merged.data, { x: 1 })
  })
})
