import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkpoint, remainingTimeout, capturePageText, capturePageJson, CdpConnection, ensureBrowser } from '../host/browser.js'
import { fetchJdDetail, JD_PROVIDERS } from '../host/jd.js'
import { captureNowcoder } from '../host/nowcoder.js'
import { fetchOfferShowSalaryHighlights } from '../host/offershow.js'

// Synthetic state + mocked HTTP/CDP only: never launches a browser or opens personal data.
async function mockBrowser(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-deadline-'))
  fs.writeFileSync(path.join(dir, 'browser-state.json'), JSON.stringify({ port: 9999 }))
  const originalFetch = globalThis.fetch, originalConnect = CdpConnection.prototype.connect, originalSend = CdpConnection.prototype.send
  const calls = []
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://mock' }) })
  CdpConnection.prototype.connect = async function () { return this }
  CdpConnection.prototype.send = async function (method, params, session, timeout) {
    calls.push({ method, params, timeout })
    if (method === 'Target.createTarget') return { targetId: 'owned' }
    if (method === 'Target.attachToTarget') return { sessionId: 'session' }
    return {}
  }
  try { await run(dir, calls) } finally {
    globalThis.fetch = originalFetch; CdpConnection.prototype.connect = originalConnect; CdpConnection.prototype.send = originalSend
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('remainingTimeout never raises small budgets and checkpoint classifies stop', () => {
  assert.ok(remainingTimeout(12000, { deadlineAt: Date.now() + 25 }) <= 25)
  assert.throws(() => checkpoint({ deadlineAt: Date.now() - 1 }), { stage: 'deadline' })
  assert.throws(() => checkpoint({ signal: AbortSignal.abort() }), { stage: 'cancelled' })
})

test('expired or cancelled capture exits before startup or any new action', async () => {
  for (const capture of [capturePageText, capturePageJson]) {
    assert.equal((await capture({ deadlineAt: Date.now() - 1 })).stage, 'deadline')
    assert.equal((await capture({ signal: AbortSignal.abort() })).stage, 'cancelled')
  }
})

test('capture deadline includes ensureBrowser HTTP wait, without starting a real browser', async () => {
  await mockBrowser(async (dataDir, calls) => {
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const started = Date.now()
    const result = await capturePageText({ dataDir, timeoutMs: 30 })
    assert.equal(result.stage, 'deadline')
    assert.ok(Date.now() - started < 400)
    assert.equal(calls.length, 0)
  })
})

test('capture abort closes only owned target; normal sends are clipped to remaining', async () => {
  await mockBrowser(async (dataDir, calls) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30)
    const result = await capturePageText({ dataDir, url: 'https://example.test/', timeoutMs: 100, signal: controller.signal })
    clearTimeout(timer)
    assert.equal(result.stage, 'cancelled')
    assert.equal(calls.filter(c => c.method === 'Target.closeTarget').length, 1)
    assert.ok(calls.filter(c => c.method !== 'Target.closeTarget').every(c => c.timeout <= 100))
    assert.equal(calls.find(c => c.method === 'Target.createTarget').params.background, true)
    assert.ok(!calls.some(c => /Browser.close|activateTarget/.test(c.method)))
  })
})

test('JSON search-box waiting is bounded from entry, not followed by another capture budget', async () => {
  await mockBrowser(async (dataDir, calls) => {
    const result = await capturePageJson({ dataDir, url: 'https://example.test/', timeoutMs: 35, search: { selector: 'input', keyword: 'test' } })
    assert.equal(result.stage, 'deadline')
    assert.equal(calls.filter(c => c.method === 'Target.closeTarget').length, 1)
    assert.ok(!calls.some(c => c.method === 'Input.dispatchKeyEvent'))
  })
})

test('shared startup waiter cancels independently and does not close browser', async () => {
  await mockBrowser(async (dataDir, calls) => {
    let release
    globalThis.fetch = async () => { await new Promise(resolve => { release = resolve }); return { ok: true, json: async () => ({}) } }
    const first = ensureBrowser({ dataDir })
    const controller = new AbortController()
    const second = ensureBrowser({ dataDir, signal: controller.signal })
    controller.abort()
    assert.equal((await second).stage, 'cancelled')
    release()
    assert.equal((await first).ok, true)
    assert.equal(calls.length, 0)
  })
})

test('JD page passes small timeout, shared deadline and signal without 12s floor', async () => {
  const signal = new AbortController().signal, deadlineAt = Date.now() + 500
  let input
  const result = await fetchJdDetail({ provider: JD_PROVIDERS.find(p => p.mode === 'page'), url: 'https://jobs.51job.com/mock', timeoutMs: 40, signal, deadlineAt,
    captureText: async args => { input = args; return { ok: false, stage: 'deadline', error: 'done' } } })
  assert.ok(input.timeoutMs <= 40)
  assert.equal(input.signal, signal)
  assert.ok(input.deadlineAt <= deadlineAt)
  assert.equal(result.stage, 'deadline')
})

test('Nowcoder reserves list and each detail in the same budget; propagates signal', async () => {
  const signal = new AbortController().signal
  const labels = [], inputs = []
  const budget = { deadline: Date.now() + 500, signal, check() {}, visit(label, operation) { labels.push(label); return operation() } }
  const result = await captureNowcoder({ keyword: '产品面经' }, { config: { dataDir: 'mock' }, budget,
    captureText: async input => { inputs.push(input); return inputs.length === 1
      ? { ok: true, links: [{ text: '产品经理真实面试经历', url: 'https://www.nowcoder.com/discuss/1234' }] }
      : { ok: true, sections: [{ text: '正文'.repeat(60) }] } } })
  assert.equal(result.ok, true)
  assert.deepEqual(labels, ['nowcoder:list', 'nowcoder:detail'])
  assert.ok(inputs.every(input => input.signal === signal && input.deadlineAt === budget.deadline && input.timeoutMs <= 500))
})

test('salary helper passes budget and deadline, reports cancellation without calling capture', async () => {
  let called = false
  const result = await fetchOfferShowSalaryHighlights({ signal: AbortSignal.abort(), captureText: async () => { called = true } })
  assert.equal(result.stage, 'cancelled'); assert.equal(called, false)
})
