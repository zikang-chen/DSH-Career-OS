// 一次性诊断脚本：打开某站点，读出渲染后的链接与可见文本，用来找「岗位列表在哪条路由」。
// 用法：node scripts/probe-page-nav.mjs https://join.qq.com
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { setTimeout as sleep } from 'node:timers/promises'

const DATA_DIR = 'D:/career_os/data'
const url = process.argv[2] ?? 'https://join.qq.com'

const browser = await ensureBrowser({ dataDir: DATA_DIR })
if (!browser.ok) {
  console.error('浏览器启动失败：', browser.error)
  process.exit(1)
}

const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Network.enable', {}, sessionId)

const xhr = []
const off = cdp.on((message) => {
  if (message.sessionId !== sessionId) return
  if (message.method === 'Network.responseReceived' && /^https?:/i.test(message.params.response.url)) {
    xhr.push({ url: message.params.response.url, mime: message.params.response.mimeType })
  }
})

await cdp.send('Page.navigate', { url }, sessionId)
await sleep(8000)

const evaluate = async (expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  return result?.result?.value
}

console.log('=== 最终地址 ===')
console.log(await evaluate('location.href'))
console.log('=== 页面标题 ===')
console.log(await evaluate('document.title'))

console.log('=== 导航链接（前 30） ===')
const links = await evaluate(`JSON.stringify([...document.querySelectorAll('a')].map(a => ({ text: (a.innerText||'').trim().slice(0,30), href: a.href })).filter(l => l.href && !l.href.startsWith('javascript')).slice(0, 30))`)
for (const link of JSON.parse(links ?? '[]')) console.log(` · [${link.text}] ${link.href}`)

console.log('=== 含「岗位/职位/招聘/实习」的可见文本（前 20） ===')
const texts = await evaluate(`JSON.stringify([...document.querySelectorAll('body *')].filter(el => el.children.length === 0 && /岗位|职位|招聘|实习|校园/.test(el.innerText||'')).map(el => (el.innerText||'').trim()).filter(t => t && t.length < 40).slice(0, 20))`)
for (const t of JSON.parse(texts ?? '[]')) console.log(` · ${t}`)

console.log('=== 页面发出的请求（去重前 25） ===')
const seen = new Set()
for (const row of xhr) {
  if (seen.has(row.url)) continue
  seen.add(row.url)
  console.log(` · ${row.mime.padEnd(28)} ${row.url.slice(0, 130)}`)
  if (seen.size >= 25) break
}

off()
await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
cdp.close()
console.log('\n（浏览器保持运行，便于继续操作）')
