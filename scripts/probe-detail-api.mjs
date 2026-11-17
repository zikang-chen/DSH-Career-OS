// 诊断：打开一个岗位详情页，把页面发出的**所有 JSON 响应连同正文**打出来，用来发现详情接口。
// 用法：node scripts/probe-detail-api.mjs "https://join.qq.com/post.html?id=22469"
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { setTimeout as sleep } from 'node:timers/promises'

const DATA_DIR = 'D:/career_os/data'
const url = process.argv[2]
if (!url) {
  console.error('用法: node scripts/probe-detail-api.mjs <详情页URL>')
  process.exit(1)
}

const browser = await ensureBrowser({ dataDir: DATA_DIR })
if (!browser.ok) { console.error('浏览器失败:', browser.error); process.exit(1) }

const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)

const keep = []
cdp.on((m) => {
  if (m.sessionId !== sessionId) return
  if (m.method !== 'Network.responseReceived') return
  const r = m.params.response
  if (!/json/i.test(r.mimeType ?? '') || !/^https?:/i.test(r.url)) return
  keep.push({ requestId: m.params.requestId, url: r.url, status: r.status })
})

await cdp.send('Page.navigate', { url }, sessionId)
await sleep(9000)

console.log(`=== 页面发出的 JSON 响应（${keep.length} 个）===`)
for (const row of keep) {
  let body = ''
  try {
    const res = await cdp.send('Network.getResponseBody', { requestId: row.requestId }, sessionId)
    body = res?.body ?? ''
    if (res?.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8')
  } catch (e) { body = `<取正文失败: ${e.message}>` }
  console.log(`\n--- ${row.status} ${row.url}`)
  console.log(`    长度 ${body.length}  预览: ${body.slice(0, 400).replace(/\s+/g, ' ')}`)
}

await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
cdp.close()
console.log('\n（浏览器保持运行）')
