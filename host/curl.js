// 复用用户自己浏览器里的合法请求（cURL / 原始 JSON）来取岗位。
//
// 为什么是这条路：
//   大厂校招站点是 SPA，数据在私有接口里，往往带签名/会话 token。硬爬要破解签名（不合规也不稳定），
//   而用浏览器渲染又要引入 Playwright 这类重依赖。但**你自己在浏览器里打开页面时，那条请求是合法的**：
//   你在 F12 里「Copy as cURL」，等于把「你被授权的这一次请求」原样交给我们重放一次。
//   我们不破解、不批量撞接口、不绕过登录态——只重放用户主动给出的那一条。
//
// 安全边界（都在代码里强制）：
//   - 只允许 http/https，明确拒绝 file://、localhost、内网 IP；
//   - 只允许 GET/POST，请求体上限 512KB，响应上限 8MB；
//   - 输出里所有敏感 header（Cookie/Authorization/token）一律脱敏；
//   - 单次重放，不做翻页循环、不做并发。

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$)/i
const PRIVATE_172 = /^172\.(1[6-9]|2\d|3[01])\./

const SENSITIVE_HEADER = /^(cookie|authorization|proxy-authorization|x-csrf-token|token|x-auth-token|x-access-token)$/i

/** cmd 的 ^ 续行 与 bash 的 \ 续行统一成空格。 */
function normalizeContinuations(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\\\n/g, ' ')
    .replace(/\^\n/g, ' ')
    .replace(/\n/g, ' ')
}

/** 按 shell 规则切词，处理单引号/双引号/反斜杠转义。 */
export function tokenize(command) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1]
        index += 1
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    // bash 里 \ 转义下一个字符（包括空格：`f\ g` → `f g`）
    if (char === '\\' && index + 1 < command.length) {
      current += command[index + 1]
      started = true
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
  }
  if (started || current) tokens.push(current)
  return tokens
}

const HEADER_FLAGS = new Set(['-h', '--header'])
const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'])
const COOKIE_FLAGS = new Set(['-b', '--cookie'])
const METHOD_FLAGS = new Set(['-x', '--request'])
const IGNORED_WITH_VALUE = new Set(['--connect-timeout', '--max-time', '-m', '--retry', '--resolve', '--interface',
  '--limit-rate', '--proto', '--tlsv1.2', '--ciphers', '-o', '--output', '--write-out', '-w'])

/**
 * 解析 DevTools「Copy as cURL (bash)」或「(cmd)」得到的命令。
 * @returns {{ok:boolean, url:string|null, method:string, headers:object, body:string|null, problems:string[], warnings:string[]}}
 */
export function parseCurl(input) {
  const command = normalizeContinuations(input)
  const problems = []
  const warnings = []
  const tokens = tokenize(command)
  if (!tokens.length) return { ok: false, url: null, method: 'GET', headers: {}, body: null, problems: ['空命令'], warnings }

  if (!/^curl(\.exe)?$/i.test(tokens[0])) {
    problems.push('这不是 curl 命令：请从 DevTools 的 Network 面板右键请求 → Copy → Copy as cURL')
  }

  let url = null
  let method = null
  let body = null
  let hasData = false
  const headers = {}

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const lower = token.toLowerCase()
    if (HEADER_FLAGS.has(lower) || METHOD_FLAGS.has(lower) || DATA_FLAGS.has(lower) || COOKIE_FLAGS.has(lower)) {
      const value = tokens[index + 1]
      index += 1
      if (value === undefined) {
        problems.push(`${token} 缺少参数`)
        continue
      }
      if (HEADER_FLAGS.has(lower)) {
        const colon = value.indexOf(':')
        if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim()
        else problems.push(`无法解析的 header：${value.slice(0, 40)}`)
      } else if (METHOD_FLAGS.has(lower)) {
        method = value.toUpperCase()
      } else if (DATA_FLAGS.has(lower)) {
        body = value
        hasData = true
      } else {
        headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${value}` : value
      }
      continue
    }
    if (IGNORED_WITH_VALUE.has(lower)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      // -k / --compressed / -s / -i / -L / --globoff 之类不影响语义，忽略即可
      if (/^-(u|user)$/i.test(token) || lower === '--user') {
        problems.push('命令里带了 -u 账号密码，请改用 Web 页面上的正常请求（登录态走 Cookie）')
      }
      continue
    }
    if (!url) url = token
  }

  if (!url) problems.push('没有找到请求地址（URL）')
  if (!method) method = hasData ? 'POST' : 'GET'
  if (body && body.length > 512 * 1024) {
    problems.push('请求体超过 512KB，不太像岗位查询请求')
  }
  if (headers.Cookie || headers.cookie) warnings.push('命令里含 Cookie：会按你的登录态重放一次，输出里已脱敏，请不要外传这条命令')

  return { ok: problems.length === 0, url, method, headers, body, problems, warnings }
}

/** 内网 / 非 http 一律拒绝：防止被当成 SSRF 跳板。 */
export function assertReplayable(request) {
  const problems = []
  let parsed = null
  try {
    parsed = new URL(String(request.url ?? ''))
  } catch {
    problems.push('URL 无法解析')
  }
  if (parsed) {
    if (!/^https?:$/.test(parsed.protocol)) problems.push(`只允许 http/https，当前是 ${parsed.protocol}`)
    const host = parsed.hostname
    if (PRIVATE_HOST.test(host) || PRIVATE_172.test(host)) problems.push('拒绝访问本机/内网地址')
    if (parsed.username || parsed.password) problems.push('URL 里带账号密码，请改用 Cookie 重放')
  }
  const method = String(request.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) problems.push(`只允许 GET/POST，当前是 ${method}`)
  return { ok: problems.length === 0, problems }
}

/** 输出用的 header 快照：值全部脱敏，只留是否存在。 */
export function redactHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER.test(key.trim()) ? `<已脱敏 ${String(value ?? '').length} 字符>` : String(value ?? '').slice(0, 120)
  }
  return out
}

/**
 * 重放一次请求。只发一次，不翻页、不重试猛刷。
 */
export async function replayRequest(request, { timeoutMs = 20000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const guard = assertReplayable(request)
  if (!guard.ok) return { ok: false, error: guard.problems.join('；'), status: null }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      body: request.method === 'GET' ? undefined : request.body ?? undefined,
      signal: controller.signal,
      redirect: 'follow',
    })
    const contentType = response.headers.get('content-type') ?? ''
    const buffer = Buffer.from(await response.arrayBuffer())
    const truncated = buffer.length > maxBytes
    const text = buffer.subarray(0, maxBytes).toString('utf8')
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType,
      bytes: buffer.length,
      truncated,
      json,
      textPreview: json ? null : text.slice(0, 1200),
      headersRedacted: redactHeaders(request.headers),
    }
  } catch (err) {
    return { ok: false, status: null, error: controller.signal.aborted ? `请求超时（${timeoutMs}ms）` : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/** cURL 文本 → 解析 → 安全检查 → 重放，一步到位。 */
export async function replayCurl(curlText, options) {
  const parsed = parseCurl(curlText)
  if (!parsed.ok) return { ok: false, stage: 'parse', ...parsed }
  const result = await replayRequest(parsed, options)
  return { ...result, stage: 'replay', request: { url: parsed.url, method: parsed.method, headers: redactHeaders(parsed.headers), hasBody: Boolean(parsed.body) }, warnings: parsed.warnings }
}

/**
 * 当响应里没识别出岗位时，告诉用户这个 JSON 长什么样——
 * 这比只说「没找到」有用得多：能看出自己是不是抓到了配置接口。
 */
export function describeJsonShape(json, depth = 0) {
  if (json === null) return 'null'
  if (Array.isArray(json)) {
    // 数组首项与自身同深度展开：否则真正的岗位字段会被省略成 {…}，看不出抓对没抓对。
    const head = json.length ? describeJsonShape(json[0], depth) : '空'
    return `数组(${json.length})${json.length ? `，首项 ${head}` : ''}`
  }
  if (typeof json === 'object') {
    if (depth >= 3) return '{…}'
    const keys = Object.keys(json).slice(0, 10)
    return `{${keys.map((key) => `${key}: ${describeJsonShape(json[key], depth + 1)}`).join(', ')}${Object.keys(json).length > 10 ? ', …' : ''}}`
  }
  if (typeof json === 'string') return `"${json.slice(0, 24)}${json.length > 24 ? '…' : ''}"`
  return String(json)
}
