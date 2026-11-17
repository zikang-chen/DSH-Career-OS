// Crawl a PUBLIC job-listing page and turn it into normalized postings.
//
// Three strategies, best first:
//   1. schema.org `JobPosting` JSON-LD — a documented public standard, richest data
//   2. embedded JSON state (__NUXT__ / __NEXT_DATA__ / window.* assignments)
//   3. anchor clustering on server-rendered listing markup
//
// This is not a headless browser: a page that renders its list only via client-side
// JavaScript yields no postings, and the caller is told exactly that instead of
// receiving fabricated rows.
import {
  extractCity,
  extractSkills,
  normalizeJob,
  parseDeadline,
  parseInternshipType,
  parseRecruitType,
  parseRemoteType,
} from './domain.js'
import { htmlToText, inferStatusFromText, politeGet, robotsAllows } from './sources.js'
import { sha1ish, str } from './util.js'

const TITLE_KEYS = ['title', 'name', 'jobName', 'job_name', 'positionName', 'position_name', 'postName', 'post_name', 'jobTitle', 'job_title', 'positionTitle', 'titleName', 'nameCn']
// 国内校招接口普遍用蛇形/带后缀的字段名（city_name / work_city / location_name），
// 少写一个就会把一整个接口判成「没有岗位」。
const LOCATION_KEYS = ['city', 'location', 'workPlace', 'workplace', 'workCity', 'cityName', 'city_name', 'jobCity', 'job_city',
  'cityList', 'address', 'locationName', 'location_name', 'work_place', 'work_city', 'base', 'region', 'city_text',
  // 对象型地点（字节 city_info，其他家 cityInfo / location_info）
  'city_info', 'cityInfo', 'city_list', 'location_info', 'locationInfo', 'city_detail', 'cities']
const URL_KEYS = ['url', 'link', 'jobUrl', 'job_url', 'detailUrl', 'detail_url', 'positionUrl', 'position_url', 'href', 'jobHref', 'applyUrl', 'apply_url', 'job_detail_url', 'position_url_pc']
const CODE_KEYS = ['id', 'jobId', 'job_id', 'positionId', 'position_id', 'code', 'postId', 'post_id', 'jobCode', 'job_code', 'post_id_str', 'job_post_id']
const DEPT_KEYS = ['department', 'dept', 'departmentName', 'department_name', 'team', 'bu', 'businessUnit', 'category', 'job_category', 'jobCategory']

const NAV_WORDS = /^(首页|上一页|下一页|末页|更多|登陆|登录|注册|搜索|关于我们|联系我们|返回|详情|查看|立即申请|apply|home|next|prev|more)$/i

/** A title-shaped string, as opposed to nav chrome or a whole paragraph. */
export function looksLikeJobTitle(text) {
  const t = String(text ?? '').trim()
  if (t.length < 2 || t.length > 80) return false
  if (NAV_WORDS.test(t)) return false
  if (/^\d+$/.test(t)) return false
  return /实习|工程师|分析师|产品|运营|研究员|开发|设计|顾问|助理|经理|专员|主管|算法|数据|前端|后端|测试|销售|财务|法务|人力|市场|供应链|autumn|intern|engineer|analyst|manager|intern/i.test(t)
}

/**
 * 把一个字段值压成可读文本。
 * 国内校招接口常把地点/类别塞成对象（city_info: {code, name}）或数组，直接 String() 会得到 [object Object]，
 * 于是「标题 + 地点」的判定就失效、整页岗位被当成没抓到。
 */
function asText(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 2) return null
  if (Array.isArray(value)) {
    const parts = value.map((item) => asText(item, depth + 1)).filter(Boolean)
    return parts.length ? parts.join(' / ') : null
  }
  if (typeof value === 'object') {
    for (const key of ['name', 'name_cn', 'nameCn', 'zh_name', 'city_name', 'label', 'text', 'title', 'value', 'desc']) {
      const found = asText(value[key], depth + 1)
      if (found) return found
    }
    return null
  }
  return null
}

function firstOf(obj, keys) {
  for (const key of keys) {
    const text = asText(obj[key])
    if (text) return text
  }
  return null
}

/** 已知站点「没有详情链接只有 id」时，按模板拼出可投递的详情页。 */
function detailUrlFor(baseUrl, code) {
  if (!baseUrl || !code) return null
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }
  const host = parsed.hostname
  if (/(^|\.)jobs\.bytedance\.com$/.test(host)) {
    // 校招与社招是两个站内应用，按来源路径判断，猜不到时按校招。
    const section = /\/experienced/.test(parsed.pathname) ? 'experienced' : 'campus'
    return `https://jobs.bytedance.com/${section}/position/${encodeURIComponent(code)}/detail`
  }
  return null
}

function absolute(href, base) {
  if (!href) return null
  try {
    const url = new URL(href, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

// ─── strategy 1: schema.org JobPosting ───────────────────────────────────────
function flattenJsonLd(node, out, depth = 0) {
  if (!node || depth > 8) return
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  if (Array.isArray(node['@graph'])) flattenJsonLd(node['@graph'], out, depth + 1)
  const type = node['@type']
  const types = Array.isArray(type) ? type : type ? [type] : []
  if (types.some((t) => String(t).toLowerCase() === 'jobposting')) out.push(node)
}

export function extractJsonLdPostings(html, baseUrl) {
  const postings = []
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(String(html ?? ''))) !== null) {
    let parsed
    try {
      parsed = JSON.parse(match[1].trim())
    } catch {
      continue
    }
    const found = []
    flattenJsonLd(parsed, found)
    for (const item of found) {
      const org = item.hiringOrganization
      const company = typeof org === 'string' ? org : org?.name ?? null
      const loc = item.jobLocation
      const locNode = Array.isArray(loc) ? loc[0] : loc
      const addr = locNode?.address ?? locNode
      const location = typeof addr === 'string'
        ? addr
        : [...new Set([addr?.addressLocality, addr?.addressRegion].filter(Boolean))].join(' ') || null
      postings.push({
        title: str(item.title ?? item.name, 200),
        url: absolute(str(item.url, 1000), baseUrl),
        company: str(company, 200),
        location: str(location, 200),
        description: str(item.description, 20000),
        publishedAt: str(item.datePosted, 40),
        deadline: str(item.validThrough, 40)?.slice(0, 10) ?? null,
        employmentType: Array.isArray(item.employmentType) ? item.employmentType.join(',') : str(item.employmentType, 80),
        jobCode: str(item.identifier?.value ?? item.identifier, 120),
        via: 'jsonld',
      })
    }
  }
  return postings.filter((p) => p.title && looksLikeJobTitle(p.title))
}

// ─── strategy 2: embedded JSON state ────────────────────────────────────────
function parseJsonLoosely(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 4_000_000) return null
  if (!/^[[{]/.test(text)) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Walk an already-parsed JSON value looking for job-like objects.
 * Used both for embedded page state and for a raw JSON API response — the latter is
 * the practical route for SPA job boards, which expose their list as JSON.
 */
export function walkJsonForPostings(parsed, baseUrl) {
  const postings = []
  const seen = new Set()
  // Breadth-first so array order (document order) is preserved in the output.
  const queue = [{ node: parsed, depth: 0 }]
  for (let i = 0; i < queue.length && i < 40_000; i += 1) {
    const { node, depth } = queue[i]
    if (!node || depth > 12) continue
    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, depth: depth + 1 })
      continue
    }
    if (typeof node !== 'object') continue
    const title = firstOf(node, TITLE_KEYS)
    const code = firstOf(node, CODE_KEYS)
    const rawUrl = firstOf(node, URL_KEYS)
    const location = firstOf(node, LOCATION_KEYS)
    // 只认「像岗位 id」的代码：字典项（recruit_type: {id:"1", name:"暑期实习"}）也带 id+name，
    // 但那种短枚举值不是岗位，会把字典表误当成岗位列表。
    const codeLooksReal = Boolean(code && /^[0-9a-zA-Z_-]{8,}$/.test(code))
    // 有 id 也算数：国内校招接口普遍只给岗位 id、不给详情链接，靠 id 能拼出投递页。
    if (title && (rawUrl || location || codeLooksReal) && looksLikeJobTitle(title)) {
      const url = rawUrl ? absolute(rawUrl, baseUrl) : detailUrlFor(baseUrl, code)
      const key = `${title}|${location ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        postings.push({
          title: str(title, 200),
          url,
          location: str(location, 200),
          department: str(firstOf(node, DEPT_KEYS), 200),
          jobCode: str(code, 120),
          description: str(node.description ?? node.jobDescription ?? node.job_description ?? node.requirement ?? node.requirements, 20000),
          requirements: str(node.requirement ?? node.requirements, 20000),
          recruitTypeText: firstOf(node, ['recruit_type', 'recruitType', 'recruitment_type', 'recruitmentType']),
          publishedAt: str(node.publishTime ?? node.publish_time ?? node.publishDate ?? node.createTime ?? node.create_time, 40),
          deadline: parseDeadline(String(node.deadline ?? node.endTime ?? node.end_time ?? node.validThrough ?? '')),
          via: 'embedded',
        })
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 })
    }
  }
  return postings
}

export function extractEmbeddedStatePostings(html, baseUrl) {
  const scripts = []
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(String(html ?? ''))) !== null) {
    const body = match[1]
    if (/\b(window|self|var|let|const)\b[^;]{0,80}=/.test(body) && /[[{]/.test(body)) {
      // window.__INITIAL_STATE__ = {...};  — keep the right-hand side only
      const eq = body.indexOf('=')
      const rhs = eq >= 0 ? body.slice(eq + 1).replace(/;\s*$/, '') : body
      scripts.push(rhs)
    } else if (/^[[{[]/.test(body.trim())) {
      scripts.push(body)
    }
  }

  const postings = []
  const seen = new Set()
  for (const raw of scripts) {
    const parsed = parseJsonLoosely(raw)
    if (!parsed) continue
    for (const posting of walkJsonForPostings(parsed, baseUrl)) {
      const key = `${posting.title}|${posting.location ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      postings.push(posting)
    }
  }
  return postings
}

// ─── strategy 3: anchor clustering ──────────────────────────────────────────
function nearbyText(html, index, span = 320) {
  const from = Math.max(0, index - span)
  const to = Math.min(html.length, index + span)
  return htmlToText(html.slice(from, to))
}

const CITY_NAMES = ['北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津',
  '重庆', '长沙', '青岛', '合肥', '厦门', '郑州', '济南', '东莞', '佛山', '宁波', '无锡', '珠海', '香港', '新加坡']

/**
 * The city closest to an anchor, searched backwards first: in a listing row the
 * location label usually precedes the title link, and a symmetric window would
 * otherwise pick up the next row's city.
 */
export function nearestCity(html, index) {
  const before = htmlToText(html.slice(Math.max(0, index - 240), index))
  let best = null
  let bestAt = -1
  for (const city of CITY_NAMES) {
    const at = before.lastIndexOf(city)
    if (at > bestAt) {
      bestAt = at
      best = city
    }
  }
  if (best) return best
  const after = htmlToText(html.slice(index, Math.min(html.length, index + 160)))
  for (const city of CITY_NAMES) {
    const at = after.indexOf(city)
    if (at >= 0) return city
  }
  return null
}

export function extractAnchorPostings(html, baseUrl) {
  const source = String(html ?? '')
  const postings = []
  const seen = new Set()
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi
  let match
  while ((match = re.exec(source)) !== null) {
    const label = htmlToText(match[2])
    if (!looksLikeJobTitle(label)) continue
    const url = absolute(match[1], baseUrl)
    if (!url || seen.has(url)) continue
    // Skip nav/category links: a posting detail URL usually carries a numeric or
    // uuid-ish segment, while a category link does not.
    const tail = url.split('/').filter(Boolean).pop() ?? ''
    const looksLikeDetail = /\d{3,}|[0-9a-f]{8,}/i.test(tail) || /job|position|detail|apply|vacanc/i.test(url)
    if (!looksLikeDetail) continue
    seen.add(url)
    postings.push({
      title: str(label, 200),
      url,
      location: nearestCity(source, match.index),
      via: 'anchors',
    })
    if (postings.length >= 500) break
  }
  return postings
}

// ─── orchestration ──────────────────────────────────────────────────────────
/**
 * Extract postings from one already-fetched page.
 * @returns {{strategy:string, postings:object[], warnings:string[], signals:object}}
 */
export function extractPostings(html, baseUrl, { signals } = {}) {
  const warnings = []
  const pageSignals = signals ?? { open: inferStatusFromText(htmlToText(html)) === 'OPEN' }

  // A raw JSON body — the standard route for an SPA job board's backing API.
  const trimmed = String(html ?? '').trim()
  if (/^[[{]/.test(trimmed)) {
    const parsed = parseJsonLoosely(trimmed)
    if (parsed) {
      const fromJson = walkJsonForPostings(parsed, baseUrl)
      if (fromJson.length) {
        warnings.push('内容按 JSON 接口解析（适配纯前端站点的数据接口）。')
        return { strategy: 'json', postings: fromJson, warnings, signals: pageSignals }
      }
      warnings.push('返回的是 JSON，但里面没有识别到岗位结构（字段名可能不常见），请检查接口参数或改用手动粘贴。')
      return { strategy: 'none', postings: [], warnings, signals: pageSignals }
    }
  }

  const jsonld = extractJsonLdPostings(html, baseUrl)
  if (jsonld.length) return { strategy: 'jsonld', postings: jsonld, warnings, signals: pageSignals }

  const embedded = extractEmbeddedStatePostings(html, baseUrl)
  if (embedded.length) return { strategy: 'embedded', postings: embedded, warnings, signals: pageSignals }

  const anchors = extractAnchorPostings(html, baseUrl)
  if (anchors.length) {
    warnings.push('只从页面链接结构识别到岗位标题/链接；岗位描述、截止日期需要抓取详情页或手动补充。')
    return { strategy: 'anchors', postings: anchors, warnings, signals: pageSignals }
  }

  const text = htmlToText(html)
  const reasons = []
  if (text.length < 400) reasons.push('页面正文过短，可能是纯前端渲染 (SPA) 或需要登录')
  reasons.push('没有找到 JSON-LD、内嵌岗位数据或可识别的岗位链接结构')
  warnings.push(`${reasons.join('；')}。请改用「手动粘贴」导入，或提供该站的招聘接口/JSON 地址。`)
  return { strategy: 'none', postings: [], warnings, signals: pageSignals }
}

/**
 * Fetch one listing page (robots first) and extract postings.
 * @param {string} url
 * @param {{timeoutMs?:number,gapMs?:number,ua?:string,signal?:AbortSignal,maxDetail?:number,company?:string}} opts
 */
export async function crawlListing(url, opts = {}) {
  const robots = await robotsAllows(url, { timeoutMs: Math.min(opts.timeoutMs ?? 20_000, 10_000), ua: opts.ua })
  if (!robots.allowed) {
    return { ok: false, url, blocked: true, error: `robots.txt 不允许抓取：${robots.reason}`, postings: [], warnings: [] }
  }
  const res = await politeGet(url, { timeoutMs: opts.timeoutMs, gapMs: opts.gapMs, ua: opts.ua, signal: opts.signal })
  if (!res.ok) {
    return {
      ok: false, url: res.url, status: res.status,
      error: res.error ? `请求失败：${res.error}` : `HTTP ${res.status}`,
      postings: [], warnings: [],
    }
  }
  const extraction = extractPostings(res.text, res.url)
  const postings = extraction.postings
  const warnings = [...extraction.warnings]

  // Optionally open a few detail pages for the description. Bounded and serial.
  const maxDetail = Math.max(0, Math.min(opts.maxDetail ?? 0, 20))
  if (maxDetail > 0 && postings.length) {
    let fetched = 0
    for (const posting of postings) {
      if (fetched >= maxDetail) break
      if (!posting.url || (posting.description && posting.description.length > 200)) continue
      if (posting.url === url) continue
      const detailRobots = await robotsAllows(posting.url, { timeoutMs: 8000, ua: opts.ua })
      if (!detailRobots.allowed) continue
      const detail = await politeGet(posting.url, { timeoutMs: opts.timeoutMs, gapMs: opts.gapMs, ua: opts.ua, signal: opts.signal })
      fetched += 1
      if (!detail.ok) continue
      const text = htmlToText(detail.text)
      if (text.length > 120) {
        posting.description = str(text, 20000)
        posting.location = posting.location ?? extractCity(text)
        posting.deadline = posting.deadline ?? parseDeadline(text)
      }
    }
    if (fetched) warnings.push(`已抓取 ${fetched} 个详情页补全描述（上限 ${maxDetail}）。`)
  }

  return {
    ok: true,
    url: res.url,
    status: res.status,
    strategy: extraction.strategy,
    signals: extraction.signals,
    postings,
    warnings,
    count: postings.length,
  }
}

/** Normalize one crawled posting into the shape `JobRepo.upsertJob` accepts. */
export function postingToJob(posting, { company, pageUrl, pageText } = {}) {
  const haystack = [posting.title, posting.description, posting.department, posting.recruitTypeText, pageText].filter(Boolean).join('\n')
  return {
    company: posting.company ?? company,
    title: posting.title,
    jobCode: posting.jobCode ?? null,
    department: posting.department ?? null,
    location: posting.location ?? (pageText ? extractCity(pageText) : null),
    url: posting.url ?? pageUrl,
    applyUrl: posting.url ?? pageUrl,
    description: posting.description ?? null,
    requirements: posting.requirements ?? posting.description ?? null,
    internshipType: parseInternshipType(haystack),
    recruitType: parseRecruitType(haystack),
    remoteType: parseRemoteType(haystack),
    publishedAt: posting.publishedAt ?? null,
    deadline: posting.deadline ?? parseDeadline(haystack),
    skills: extractSkills(haystack),
    tags: posting.via ? [`crawl:${posting.via}`] : [],
  }
}

export function crawlFingerprint(result) {
  return sha1ish(`${result.url}|${result.strategy}|${(result.postings ?? []).length}|${(result.postings ?? []).map((p) => p.url ?? p.title).sort().join(',')}`)
}
