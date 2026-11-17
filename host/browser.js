// 专用浏览器 + CDP 抓取：让「登录一次，之后自动抓」成为可能。
//
// 为什么不用 DSH 内置浏览器：
//   内置浏览器是沙箱化 Electron <webview>，它的 bridge 只开放 acquire/release/onOpenRequested
//   （见 dsh-client-ui-sidebar-browser/src/types.ts，注释明确 "no Electron objects or arbitrary IPC cross this interface"）。
//   插件读不到那页面的 DOM、Cookie 或网络请求。
//
// 所以这里另起一个**独立浏览器进程**（Edge/Chrome），用插件自己的 profile 目录：
//   1. 用户在这个窗口里正常登录目标站点 —— 登录态落在 data/browser-profile，重启仍在；
//   2. 之后插件用 CDP（Chrome DevTools Protocol）导航到岗位页，监听 Network 事件，
//      把页面自己发出的 JSON 响应取回来解析。
//
// 边界（与 curl 重放一致，且更严）：
//   - 只在 127.0.0.1 上开调试端口；不监听外部地址；
//   - 只读页面自己发出的请求，不构造/伪造请求、不破解签名、不绕过登录；
//   - 一次一个页面，串行；不并发、不刷接口；
//   - profile 独立存放，不碰用户日常浏览器的数据。
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const STATE_FILE = 'browser-state.json'

/** 找本机可用的 Chromium 内核浏览器（Edge 在 Win10/11 上基本必有）。 */
export function findBrowserExecutable() {
  const env = process.env
  const candidates = [
    path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch { /* ignore */ }
  }
  return null
}

export function browserProfileDir(dataDir) {
  return path.join(dataDir, 'browser-profile')
}

function statePath(dataDir) {
  return path.join(dataDir, STATE_FILE)
}

export function readBrowserState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'))
  } catch {
    return null
  }
}

function writeBrowserState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2))
}

/** 拿一个空闲端口，避免和系统里别的调试端口撞。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function cdpVersion(port, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动（或复用）专用浏览器。
 * @returns {{ok:boolean, port:number|null, executable:string|null, profileDir:string, started:boolean, error?:string}}
 */
export async function ensureBrowser({ dataDir, logger, extraArgs = [], noProxy = true } = {}) {
  const profileDir = browserProfileDir(dataDir)
  const previous = readBrowserState(dataDir)
  if (previous?.port) {
    const alive = await cdpVersion(previous.port)
    // 代理模式变了就得重启：正在跑的实例带着旧的网络设置。
    const sameMode = (previous.noProxy ?? true) === noProxy
    if (alive && sameMode) {
      return { ok: true, port: previous.port, executable: previous.executable ?? null, profileDir, started: false, note: '复用已运行的专用浏览器' }
    }
    if (alive && !sameMode) {
      await closeBrowser({ dataDir, logger })
    }
  }

  const executable = findBrowserExecutable()
  if (!executable) {
    return {
      ok: false, port: null, executable: null, profileDir, started: false,
      error: '没找到 Edge/Chrome。请安装 Microsoft Edge 或 Google Chrome 后重试。',
    }
  }

  const port = await freePort()
  fs.mkdirSync(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeSidebarV2,msShoppingHub',
    '--window-size=1280,900',
    // 校招站是境内站点，直连即可；跟着系统代理走反而可能被挡（实测 join.qq.com 直连通、走代理报错）。
    ...(noProxy ? ['--no-proxy-server'] : []),
    ...extraArgs,
    'about:blank',
  ]
  try {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch (err) {
    return { ok: false, port: null, executable, profileDir, started: false, error: String(err?.message ?? err) }
  }

  // 等调试端口就绪（首次启动可能要几秒）
  let info = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250)
    info = await cdpVersion(port)
    if (info) break
  }
  if (!info) {
    return { ok: false, port, executable, profileDir, started: true, error: '浏览器已启动但调试端口没响应（可能被安全策略拦住）' }
  }
  writeBrowserState(dataDir, { port, executable, profileDir, noProxy, startedAt: new Date().toISOString() })
  logger?.info?.('browser started', { port, executable, noProxy })
  return { ok: true, port, executable, profileDir, started: true, noProxy, product: info.Browser ?? null }
}

// ─── 极简 CDP 客户端 ─────────────────────────────────────────────────────────
export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
  }

  async connect(timeoutMs = 8000) {
    const socket = new WebSocket(this.wsUrl)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP 连接失败：${event?.message ?? 'socket error'}`))
      }, { once: true })
    })
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message ?? 'CDP error'}`))
        else entry.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
    return this
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.socket.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30000)
    })
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    try {
      this.socket?.close()
    } catch { /* ignore */ }
  }
}

/** 按关键词给响应排序：越像「岗位列表」越靠前。 */
export function rankResponseCandidate({ url = '', mimeType = '', size = 0 }, patterns = []) {
  const lower = String(url).toLowerCase()
  if (!/json/i.test(mimeType) && !/json/i.test(lower)) return { score: 0, reason: '非 JSON' }
  let score = 10
  const reasons = []
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(lower)) {
      score += 25
      reasons.push(pattern)
    }
  }
  if (/\/api\//.test(lower)) { score += 8; reasons.push('/api/') }
  // 「查询/列表」语义比别的强
  if (/(search|query|joblist|postlist|paged?list)/.test(lower)) { score += 18; reasons.push('查询语义') }
  // 字典/配置/横幅/城市映射这类永远不是岗位列表，即使 URL 里带 post 字样
  // （腾讯的 /api/v1/dictionary/?types=...,RecruitProjectPostList 就被 post 命中过）
  if (/(dictionary|config|setting|banner|mapping|workcity|getcity|family|filter)/.test(lower)) {
    score -= 40
    reasons.push('配置类降权')
  }
  if (size > 2000) { score += 5; reasons.push('体积较大') }
  if (size > 60000) { score -= 3; reasons.push('体积过大') }
  // encodedDataLength 在压缩响应上并不可靠（腾讯 10 条岗位只报 73 字节），
  // 所以这里只轻微降权，真正的「空结果」由解析后的岗位条数决定。
  if (size > 0 && size < 500) { score -= 6; reasons.push('体积偏小') }
  return { score, reason: reasons.join(',') || '一般 JSON' }
}

/** 只看真正的网络请求：data:/blob: 是内联资源，既没用又会把候选列表淹没。 */
function isNetworkUrl(url) {
  return /^https?:/i.test(String(url ?? ''))
}

/**
 * 打开一个页面，捕获它自己发出的 JSON 响应，挑最像岗位列表的那个返回。
 *
 * 两种模式：
 *   - `matchUrl`：先在已打开的标签页里找同源页面，附着上去 **重新加载**（登录态在，XHR 重新发一遍）。
 *     用于「我不知道岗位列表在哪条路由，但用户已经点进去了」这种情况。
 *   - 否则新开标签导航到 `url`。
 */
export async function capturePageJson({
  dataDir, url, matchUrl, patterns = ['job', 'post', 'position', 'search', 'campus', 'recruit'],
  timeoutMs = 25000, logger,
} = {}) {
  const browser = await ensureBrowser({ dataDir, logger })
  if (!browser.ok) return { ok: false, error: browser.error, browser }

  const info = await cdpVersion(browser.port)
  const wsUrl = info?.webSocketDebuggerUrl
  if (!wsUrl) return { ok: false, error: '拿不到 CDP WebSocket 地址', browser }

  const cdp = await new CdpConnection(wsUrl).connect()
  try {
    let targetId = null
    let attached = null
    let reusedTab = false

    // 优先复用用户已经打开的标签页
    if (matchUrl) {
      const { targetInfos = [] } = await cdp.send('Target.getTargets')
      const wanted = new URL(matchUrl)
      const candidates = targetInfos
        .filter((target) => target.type === 'page' && isNetworkUrl(target.url))
        .filter((target) => {
          try {
            const origin = new URL(target.url)
            return origin.origin === wanted.origin
              && (target.url.includes(wanted.pathname) || wanted.pathname === '/')
          } catch {
            return false
          }
        })
      if (candidates.length) {
        // 取最后一个：通常是最新打开的那个
        const picked = candidates[candidates.length - 1]
        targetId = picked.targetId
        attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        reusedTab = true
      }
    }

    if (!targetId) {
      if (!url) return { ok: false, error: '既没有可复用的标签页，也没给 url', browser }
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
      targetId = created.targetId
      attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    }

    const sessionId = attached.sessionId
    const responses = new Map()
    const off = cdp.on((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method !== 'Network.responseReceived') return
      const { requestId, response } = message.params
      if (!isNetworkUrl(response.url)) return
      responses.set(requestId, {
        requestId,
        url: response.url,
        mimeType: response.mimeType ?? '',
        status: response.status,
        size: Number(response.encodedDataLength ?? 0),
      })
    })

    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    // 复用时不能导航（用户可能在登录流程里），只重载当前页让 XHR 重新发一遍
    if (reusedTab) await cdp.send('Page.reload', { ignoreCache: true }, sessionId)
    else await cdp.send('Page.navigate', { url }, sessionId)

    const started = Date.now()
    let best = null
    while (Date.now() - started < timeoutMs) {
      await sleep(600)
      for (const candidate of responses.values()) {
        const ranked = rankResponseCandidate(candidate, patterns)
        if (ranked.score >= 35 && (!best || ranked.score > best.ranked.score)) {
          best = { ...candidate, ranked }
        }
      }
      if (best && Date.now() - started > 5000) break
    }
    off()

    const candidates = [...responses.values()]
      .map((candidate) => ({ ...candidate, ...rankResponseCandidate(candidate, patterns) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ requestId, url: responseUrl, status, mimeType, size, score, reason }) => ({ requestId, url: responseUrl, status, mimeType, size, score, reason }))

    if (!best) {
      if (!reusedTab) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      return { ok: false, error: '页面没有发出像「岗位列表」的 JSON 请求', candidates, reusedTab, browser }
    }

    const body = await cdp.send('Network.getResponseBody', { requestId: best.requestId }, sessionId)
    let json = null
    try {
      json = JSON.parse(body?.body ?? '')
    } catch {
      try {
        json = JSON.parse(Buffer.from(body?.body ?? '', 'base64').toString('utf8'))
      } catch {
        json = null
      }
    }
    if (!reusedTab) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    if (json === null) return { ok: false, error: '响应体不是 JSON（可能被压缩或需要二次请求）', candidates, reusedTab, browser }
    return { ok: true, captured: { url: best.url, status: best.status, bytes: String(body?.body ?? '').length, json }, candidates, reusedTab, browser }
  } finally {
    cdp.close()
  }
}

/** 只开窗口让用户登录，不抓取。 */
export async function openForLogin({ dataDir, url, logger }) {
  const browser = await ensureBrowser({ dataDir, logger, extraArgs: url ? [url] : [] })
  if (!browser.ok) return { ok: false, error: browser.error }
  if (!browser.started && url) {
    // 复用已有实例时，用 CDP 新开一个标签页
    const info = await cdpVersion(browser.port)
    if (info?.webSocketDebuggerUrl) {
      const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()
      try {
        await cdp.send('Target.createTarget', { url })
      } finally {
        cdp.close()
      }
    }
  }
  return {
    ok: true,
    port: browser.port,
    profileDir: browser.profileDir,
    executable: browser.executable,
    started: browser.started,
    note: url
      ? `已打开 ${url}。请在这个窗口里完成登录；登录态保存在 ${browser.profileDir}，下次不用再登。`
      : '专用浏览器已启动。',
  }
}

/** 关闭专用浏览器（结束时调用，避免留后台进程）。 */
export async function closeBrowser({ dataDir, logger } = {}) {
  const state = readBrowserState(dataDir)
  if (!state?.port) return { ok: true, closed: false }
  const info = await cdpVersion(state.port)
  if (info?.webSocketDebuggerUrl) {
    const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()
    try {
      await cdp.send('Browser.close')
    } catch (err) {
      logger?.warn?.('browser close failed', { error: String(err?.message ?? err) })
    } finally {
      cdp.close()
    }
  }
  try {
    fs.unlinkSync(statePath(dataDir))
  } catch { /* ignore */ }
  return { ok: true, closed: true }
}
