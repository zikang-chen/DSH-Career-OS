// 拉某个 URL 下指定接口的响应体，打印结构（用于校准解析器）。
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { setTimeout as sleep } from 'node:timers/promises'

const page = process.argv[2]
const match = process.argv[3] ?? ''
const browser = await ensureBrowser({ dataDir: 'D:/career_os/data' })
const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)

const hits = []
cdp.on((m) => {
  if (m.sessionId !== sessionId) return
  if (m.method !== 'Network.responseReceived') return
  const r = m.params.response
  if (/json/i.test(r.mimeType ?? '') && r.url.includes(match)) hits.push({ requestId: m.params.requestId, url: r.url, status: r.status })
})
await cdp.send('Page.navigate', { url: page }, sessionId)
await sleep(13000)
console.log('命中接口数:', hits.length)
for (const h of hits.slice(0, 2)) {
  try {
    const res = await cdp.send('Network.getResponseBody', { requestId: h.requestId }, sessionId)
    const body = res?.base64Encoded ? Buffer.from(res.body ?? '', 'base64').toString('utf8') : (res?.body ?? '')
    console.log(`\n=== ${h.url} (${body.length}B) ===`)
    console.log(body.slice(0, 2200))
  } catch (e) { console.log('取体失败', e.message) }
}
await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
cdp.close()
