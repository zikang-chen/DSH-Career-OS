// 探测公开可访问的岗位接口：只做 GET/POST 到对方自己的公开站点，不绕访问控制、不带登录态。
// 目的：找出「浏览器里那条请求」到底打到哪个地址，从而不必依赖用户手动 F12。
//
// 用法：node scripts/probe-campus-api.mjs [页面URL]
import { setTimeout as sleep } from 'node:timers/promises'

const PAGE = process.argv[2] ?? 'https://jobs.bytedance.com/campus'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const GAP = 900

async function get(url, { method = 'GET', body, headers = {}, timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...headers },
      body,
      signal: controller.signal,
      redirect: 'follow',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', bytes: buffer.length, text: buffer.subarray(0, 3_000_000).toString('utf8') }
  } catch (err) {
    return { status: 0, error: String(err?.message ?? err), text: '' }
  } finally {
    clearTimeout(timer)
  }
}

function extractScripts(html, base) {
  const out = []
  const re = /<script[^>]+src=["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(new URL(m[1], base).href)
    } catch { /* ignore */ }
  }
  return [...new Set(out)]
}

function findApiPaths(text) {
  const found = new Set()
  const patterns = [
    // 引号包起来的完整路径（最可靠）
    /["'`](\/api\/[a-z0-9_\-./{}:]*[a-z0-9_\-}/])["'`]/gi,
    /["'`](https?:\/\/[a-z0-9.\-]+\/api\/[a-z0-9_\-./{}:]*[a-z0-9_\-}/])["'`]/gi,
    // 拼接式：base 与子路径分开写，只能不要求闭合引号
    /\/api\/v\d+\/[a-z0-9_\-\/]{3,80}/gi,
    /\/api\/[a-z0-9_\-]+\/[a-z0-9_\-\/]{3,80}/gi,
    // 路由表里的岗位关键词片段
    /["'`](\/[a-z0-9_\-\/]*(?:job|post|position)[a-z0-9_\-\/]*)["'`]/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) {
      const value = (m[1] ?? m[0]).trim()
      if (value.length > 6 && value.length < 160) found.add(value)
    }
  }
  return found
}

function summarize(text) {
  try {
    const json = JSON.parse(text)
    const describe = (node, depth = 0) => {
      if (Array.isArray(node)) return `数组(${node.length})${node.length ? ` 首项 ${describe(node[0], depth + 1)}` : ''}`
      if (node && typeof node === 'object') {
        if (depth >= 2) return '{…}'
        return `{${Object.keys(node).slice(0, 8).join(', ')}}`
      }
      return typeof node
    }
    return describe(json)
  } catch {
    const looksHtml = /^\s*<(!doctype|html)/i.test(text)
    return looksHtml ? '<HTML 页面>' : text.slice(0, 120).replace(/\s+/g, ' ')
  }
}

async function main() {
  console.log(`[1/4] 打开 ${PAGE}`)
  const page = await get(PAGE)
  console.log(`      status=${page.status} type=${page.contentType} bytes=${page.bytes}`)
  if (page.status !== 200) {
    console.log('      页面打不开，后面的探测没有意义。')
    return
  }

  console.log('[2/4] 找 JS bundle')
  const scripts = extractScripts(page.text, PAGE)
  console.log(`      共 ${scripts.length} 个 script，全部扫描`)

  const candidates = new Set(findApiPaths(page.text))
  let scanned = 0
  for (const src of scripts) {
    const js = await get(src)
    scanned += 1
    const found = js.status === 200 ? findApiPaths(js.text) : new Set()
    if (found.size) console.log(`      [${scanned}/${scripts.length}] ${js.status} ${(js.bytes / 1024).toFixed(0)}KB ${new URL(src).pathname.slice(-40)} → 候选 ${found.size}`)
    for (const path of found) candidates.add(path)
    await sleep(GAP)
    if (candidates.size > 600) break
  }
  console.log(`      扫描完毕：${scanned} 个 bundle，候选 ${candidates.size} 个`)

  console.log(`[3/4] 去重后候选 ${candidates.size} 个，挑与岗位相关性高的`)
  const ranked = [...candidates]
    .filter((path) => /job|post|position|search|campus|recruit|career/i.test(path))
    .slice(0, 14)
  console.log(`      入选 ${ranked.length} 条`)
  for (const path of ranked) console.log(`      · ${path}`)

  console.log('[4/4] 逐个试（GET，限速）')
  const results = []
  for (const path of ranked) {
    const url = path.startsWith('http') ? path : new URL(path, PAGE).href
    const res = await get(url, { headers: { accept: 'application/json' } })
    const isJson = /json/i.test(res.contentType)
    console.log(`      ${String(res.status).padEnd(3)} ${isJson ? 'JSON' : '    '} ${(res.bytes / 1024).toFixed(1).padStart(7)}KB  ${path}`)
    if (isJson && res.text.length > 20) {
      console.log(`          → ${summarize(res.text)}`)
      results.push({ path, url, status: res.status, bytes: res.bytes, shape: summarize(res.text) })
    }
    await sleep(GAP)
  }

  console.log('\n=== 可用候选（返回 JSON）===')
  if (!results.length) console.log('（没有返回 JSON 的匿名接口：这个站点大概率要求登录态，或接口需要 POST）')
  for (const row of results) console.log(`${row.status}  ${row.url}\n     ${row.shape}`)
}

await main()
