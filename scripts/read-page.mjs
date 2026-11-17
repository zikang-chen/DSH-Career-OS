// 用专用浏览器（CDP）读取一个页面的正文，绕过服务端 403（读的是浏览器渲染后的文本）。
// 用法：node scripts/read-page.mjs <url> [maxChars]
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
const maxChars = Number(process.argv[3] ?? 6000)
if (!url) { console.error('用法: node scripts/read-page.mjs <url> [maxChars]'); process.exit(1) }

const browser = await ensureBrowser({ dataDir: 'D:/career_os/data' })
if (!browser.ok) { console.error('浏览器失败:', browser.error); process.exit(1) }
const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Page.navigate', { url }, sessionId)
await sleep(6000)

const evalJs = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
  return r?.result?.value
}
const title = await evalJs('document.title')
const text = await evalJs('document.body ? document.body.innerText : ""')
console.log('=== TITLE ===')
console.log(title)
console.log('=== TEXT ===')
console.log(String(text ?? '').slice(0, maxChars))

await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
cdp.close()
