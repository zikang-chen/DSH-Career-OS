// 真实站点探测：打开某站点搜索页，抓页面自身发出的所有 JSON，用对应解析器试解析。
// 用法：node scripts/probe-site.mjs <site> <keyword> [waitMs]
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { SITE_PROFILES } from '../host/sites.js'
import { setTimeout as sleep } from 'node:timers/promises'

const site = process.argv[2]
const keyword = process.argv[3] ?? 'AI产品经理'
const waitMs = Number(process.argv[4] ?? 12000)
const profile = SITE_PROFILES[site]
if (!profile) { console.error('未知 site，可选:', Object.keys(SITE_PROFILES).join(', ')); process.exit(1) }

const url = profile.searchUrl({ keyword })
console.log(`[probe] site=${site} url=${url}`)

const browser = await ensureBrowser({ dataDir: 'D:/career_os/data' })
if (!browser.ok) { console.error('浏览器失败:', browser.error); process.exit(1) }
const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)

const responses = new Map()
cdp.on((m) => {
  if (m.sessionId !== sessionId) return
  if (m.method !== 'Network.responseReceived') return
  const r = m.params.response
  if (/json/i.test(r.mimeType ?? '') && /^https?:/i.test(r.url)) {
    responses.set(m.params.requestId, { requestId: m.params.requestId, url: r.url, status: r.status })
  }
})

await cdp.send('Page.navigate', { url }, sessionId)
await sleep(waitMs)

const evalJs = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId))?.result?.value
console.log('[probe] finalUrl =', await evalJs('location.href'))
console.log('[probe] title    =', await evalJs('document.title'))
console.log(`[probe] JSON 响应数 = ${responses.size}`)

const rows = []
for (const r of responses.values()) {
  let body = ''
  try {
    const res = await cdp.send('Network.getResponseBody', { requestId: r.requestId }, sessionId)
    body = res?.base64Encoded ? Buffer.from(res.body ?? '', 'base64').toString('utf8') : (res?.body ?? '')
  } catch { continue }
  let parsed = 0
  let json = null
  try { json = JSON.parse(body); parsed = profile.parse(json).length } catch { parsed = -1 }
  rows.push({ url: r.url, status: r.status, bytes: body.length, parsed, preview: body.slice(0, 220).replace(/\s+/g, ' ') })
}

rows.sort((a, b) => (b.parsed - a.parsed) || (b.bytes - a.bytes))
console.log('\n=== 候选响应（按解析条数排序）===')
for (const row of rows.slice(0, 12)) {
  console.log(`parsed=${String(row.parsed).padStart(3)} ${row.status} ${String(row.bytes).padStart(7)}B  ${row.url.slice(0, 120)}`)
  if (row.parsed > 0) console.log(`        预览: ${row.preview}`)
}
if (!rows.length) console.log('（没有任何 JSON 响应：可能需要登录，或站点拦截）')

await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
cdp.close()
console.log('\n（浏览器保持运行）')
