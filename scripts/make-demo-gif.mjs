// Renders the real OverviewTab component (same bundle the panel ships) with real local
// data, then screenshots it in the dedicated browser to build a demo GIF.
// Usage: node scripts/make-demo-gif.mjs [--width 1280]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpConnection, ensureBrowser } from '../host/browser.js'
import { CareerDb } from '../host/db.js'
import { Repos } from '../host/repo/index.js'
import { buildToday } from '../host/today.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, '.tmp', 'demo')
const DATA = path.join(ROOT, 'data')
const WIDTH = Number(process.argv.includes('--width') ? process.argv[process.argv.indexOf('--width') + 1] : 1280)
const HEIGHT = 900

// ── stub React, identical contract to tests/render.test.mjs ──────────────────
function makeReact() {
  const createElement = (type, props, ...children) => ({ $$el: true, type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } })
  const noop = () => {}
  class Component { constructor(props) { this.props = props; this.state = {} } setState(p) { this.state = { ...this.state, ...(typeof p === 'function' ? p(this.state) : p) } } }
  return { createElement, Component, useState: (i) => [typeof i === 'function' ? i() : i, noop], useEffect: noop, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), useReducer: (r, i) => [i, noop], useLayoutEffect: noop, memo: (c) => c, Fragment: 'Fragment' }
}
const React = makeReact()
const reactDom = { createPortal: (node) => node }

function renderTree(node, depth = 0) {
  if (depth > 400) throw new Error('renderTree recursion')
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((c) => renderTree(c, depth + 1))
  if (!node.$$el) return node
  const { type, props } = node
  if (typeof type === 'function') return renderTree(type(props), depth + 1)
  return node
}

function loadBundle() {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'wrapped-bundle.js'), 'utf8')
  let captured = null
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { captured = r } }, localStorage: { getItem: () => null, setItem: () => {} } }, document: { body: {} }, console }
  const require = (id) => id === 'react' ? React : id === 'react-dom' ? reactDom : (() => { throw new Error(`unexpected require(${id})`) })()
  new Function('window', 'document', 'console', 'require', source)(sandbox.window, sandbox.document, console, require)
  if (!captured) throw new Error('bundle did not register')
  return captured.factory(require)
}

// ── real data ───────────────────────────────────────────────────────────────
function realToday() {
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const db = new CareerDb(path.join(DATA, 'career.db'), logger).open()
  try {
    const repos = new Repos(db, logger)
    return buildToday(repos)
  } finally { try { db.close() } catch { /* ignore */ } }
}

// ── html emit ───────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const css = (style) => Object.entries(style ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${typeof v === 'number' && !['opacity', 'zIndex', 'flex', 'lineHeight', 'fontWeight'].includes(k) ? v + 'px' : v}`).join(';')

function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (!node?.$$el) return ''
  const { type, props } = node
  if (typeof type === 'function') return toHtml(renderTree(node))
  if (typeof type !== 'string') return ''
  const tag = type === 'Fragment' ? 'div' : type
  const attrs = [`style="${css(props?.style)}"`]
  if (props?.className) attrs.push(`class="${esc(props.className)}"`)
  if (props?.href) attrs.push(`href="${esc(props.href)}"`)
  if (props?.role) attrs.push(`role="${esc(props.role)}"`)
  return `<${tag} ${attrs.join(' ')}>${toHtml(props?.children)}</${tag}>`
}

const internals = loadBundle().__internals
const today = realToday()
const tree = renderTree(React.createElement(internals.OverviewTab, { bootstrap: { today, profile: today.profile, resumes: [], skills: [] }, onNavigate: () => {}, onRefresh: () => {} }))
const body = toHtml({ $$el: true, type: 'div', props: tree?.props ?? { children: tree } })

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#f6f7f9;}
  body{font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;color:#111827;font-size:13px;line-height:1.55;}
  .wrap{max-width:1040px;margin:0 auto;padding:28px 32px 40px;}
  .bar{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
  .dot{width:10px;height:10px;border-radius:50%;background:#2563eb;}
  .name{font-weight:600;font-size:15px;}
  .hint{color:#6b7280;font-size:12px;}
  *{box-sizing:border-box;}
</style></head><body><div class="wrap">
<div class="bar"><span class="dot"></span><span class="name">CareerOS</span><span class="hint">求职面板 · 总览（本地真实数据渲染）</span></div>
${body}</div></body></html>`

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'overview.html'), html, 'utf8')

// ── serve, screenshot, exit ────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await ensureBrowser({ dataDir: DATA })
if (!browser.ok) { server.close(); throw new Error(browser.error ?? 'browser unavailable') }
const info = await fetch(`http://127.0.0.1:${browser.port}/json/version`).then((r) => r.json())
const cdp = await new CdpConnection(info.webSocketDebuggerUrl).connect()
let targetId
try {
  ;({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }))
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  await new Promise((r) => setTimeout(r, 1200))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true }, sessionId, 20000)
  const png = Buffer.from(shot.data, 'base64')
  fs.writeFileSync(path.join(OUT, 'overview-full.png'), png)
  console.log(JSON.stringify({ ok: true, url, bytes: png.length, out: path.join(OUT, 'overview-full.png') }))
} finally {
  if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 1500).catch(() => {})
  cdp.close(); server.closeAllConnections?.(); server.close()
}
// Keep-alive sockets from the browser would otherwise hold the process open.
process.exit(0)
