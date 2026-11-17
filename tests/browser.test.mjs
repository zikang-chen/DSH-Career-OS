// 专用浏览器模块的纯逻辑测试（不启动浏览器、不开端口、不联网）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  browserProfileDir,
  findBrowserExecutable,
  freePort,
  rankResponseCandidate,
  readBrowserState,
} from '../host/browser.js'

describe('browser discovery', () => {
  it('returns an .exe path or null, never a fabricated path', () => {
    const executable = findBrowserExecutable()
    if (executable === null) {
      assert.equal(executable, null, 'no browser installed is an honest answer')
      return
    }
    assert.equal(typeof executable, 'string')
    assert.match(executable, /\.exe$/i)
    assert.match(executable, /(msedge|chrome)\.exe$/i)
  })

  it('keeps the profile inside the plugin data dir', () => {
    const dir = browserProfileDir('D:\\career_os\\data')
    assert.equal(dir, path.join('D:\\career_os\\data', 'browser-profile'))
    assert.ok(dir.startsWith('D:\\career_os\\data'))
  })

  it('reports no state before the browser has ever started', () => {
    assert.equal(readBrowserState(path.join(process.cwd(), '__definitely-not-a-data-dir__')), null)
  })

  it('hands out a usable free port', async () => {
    const port = await freePort()
    assert.equal(typeof port, 'number')
    assert.ok(port > 1024 && port < 65536, `unexpected port ${port}`)
  })
})

describe('response ranking', () => {
  const jobUrl = 'https://jobs.example.com/api/v1/search/job/posts'

  it('prefers a JSON response whose URL looks like a job listing', () => {
    const ranked = rankResponseCandidate({ url: jobUrl, mimeType: 'application/json', size: 9000 }, ['job', 'post'])
    assert.ok(ranked.score >= 35, `score ${ranked.score} should clear the capture bar`)
    assert.match(ranked.reason, /job/)
  })

  it('rejects non-JSON outright', () => {
    const ranked = rankResponseCandidate({ url: 'https://a.com/style.css', mimeType: 'text/css', size: 9000 })
    assert.equal(ranked.score, 0)
    assert.equal(ranked.reason, '非 JSON')
  })

  it('ranks a config endpoint below a listing endpoint', () => {
    const listing = rankResponseCandidate({ url: 'https://a.com/api/search/job/posts', mimeType: 'application/json', size: 20000 }, ['job', 'post'])
    const config = rankResponseCandidate({ url: 'https://a.com/api/config/theme', mimeType: 'application/json', size: 300 }, ['job', 'post'])
    assert.ok(listing.score > config.score)
  })

  it('penalises oversized payloads so the capture does not grab a full page blob', () => {
    const small = rankResponseCandidate({ url: jobUrl, mimeType: 'application/json', size: 5000 }, ['job'])
    const huge = rankResponseCandidate({ url: jobUrl, mimeType: 'application/json', size: 9000000 }, ['job'])
    assert.ok(huge.score < small.score)
  })

  it('does not depend on the caller passing patterns', () => {
    const ranked = rankResponseCandidate({ url: 'https://a.com/api/x', mimeType: 'application/json', size: 5000 })
    assert.ok(ranked.score > 0)
    assert.match(ranked.reason, /\/api\//)
  })
})
