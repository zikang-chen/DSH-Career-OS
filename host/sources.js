// Data-source connectors.
//
// Policy (spec §5.4): only official APIs, authorised interfaces, clearly public
// pages that robots.txt permits, and text the user supplies. Nothing here logs in,
// solves a captcha, reuses cookies, or impersonates a user. A connector that cannot
// get data legally reports that instead of inventing records.
import {
  extractSkills,
  normalizeJob,
  parseDeadline,
  parseDaysPerWeek,
  parseGradeLimit,
  parseInternshipType,
  parseRemoteType,
} from './domain.js'
import { sha1ish, str } from './util.js'

export const DEFAULT_UA = 'Mozilla/5.0 (compatible; CareerOS/0.1; +local personal research tool)'

// ─── robots.txt ──────────────────────────────────────────────────────────────
/**
 * Minimal but correct robots.txt evaluation for our own user-agent and `*`.
 * Longest matching rule wins; Allow beats Disallow at equal length.
 * @returns {Promise<{allowed:boolean, reason:string}>}
 */
export async function robotsAllows(url, { timeoutMs = 8000, ua = DEFAULT_UA } = {}) {
  let target
  try {
    target = new URL(url)
  } catch {
    return { allowed: false, reason: '无效的 URL' }
  }
  let body
  try {
    const res = await fetch(`${target.origin}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': ua },
    })
    if (!res.ok) return { allowed: true, reason: `robots.txt 返回 ${res.status}，视为无限制` }
    body = await res.text()
  } catch (err) {
    return { allowed: true, reason: `robots.txt 不可达（${String(err?.message ?? err).slice(0, 80)}），按允许处理` }
  }

  const groups = []
  let current = null
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], rules: [] }
      groups.push(current)
    } else if (current && (key === 'disallow' || key === 'allow')) {
      current.rules.push({ type: key, path: value })
    }
  }

  const ours = 'careeros'
  const relevant = groups.filter((g) => g.agents.some((a) => a === '*' || ours.includes(a) || a.includes(ours)))
  const path = target.pathname || '/'
  let best = null
  for (const group of relevant) {
    for (const rule of group.rules) {
      if (!rule.path) continue
      const matches = rule.path === '/' ? path === '/' : path.startsWith(rule.path)
      if (!matches) continue
      const score = rule.path.length
      if (!best || score > best.score || (score === best.score && rule.type === 'allow')) {
        best = { score, type: rule.type, path: rule.path }
      }
    }
  }
  if (best) {
    return best.type === 'allow'
      ? { allowed: true, reason: `robots.txt 允许 ${best.path}` }
      : { allowed: false, reason: `robots.txt 禁止 ${best.path}` }
  }
  return { allowed: true, reason: 'robots.txt 未限制该路径' }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
let lastRequestAt = 0

/** Serialised, rate-limited GET. Resolves with the status instead of throwing. */
export async function politeGet(url, { timeoutMs = 20_000, gapMs = 2500, ua = DEFAULT_UA, signal } = {}) {
  const wait = Math.max(0, lastRequestAt + gapMs - Date.now())
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
  try {
    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, url: res.url || url }
  } catch (err) {
    return { ok: false, status: 0, text: '', url, error: String(err?.message ?? err) }
  }
}

// ─── HTML helpers ────────────────────────────────────────────────────────────
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

const JOB_LINK_RE = /(实习|招聘|校招|社招|campus|career|job|position|intern|opening|recruit|vacanc)/i
const CLOSED_SIGNAL_RE = /(招聘已结束|暂无职位|暂无招聘|停止招聘|已结束|no openings|positions? closed|暂无开放岗位|该职位已下线)/i
const UPCOMING_SIGNAL_RE = /(即将开启|即将启动|敬请期待|即将开始申报|coming soon|opens? soon)/i
const OPEN_SIGNAL_RE = /(正在招聘|热招|在招|立即投递|申请职位|网申入口|apply now|open positions?|现在申请)/i

/** Candidate job links plus page-level hiring signals. */
export function parseCareersPage(html, baseUrl) {
  const text = htmlToText(html)
  const links = []
  const seen = new Set()
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const href = m[1]
    const label = htmlToText(m[2])
    if (!href || href.startsWith('#') || href.startsWith('javascript') || href.startsWith('mailto')) continue
    if (!(JOB_LINK_RE.test(href) || JOB_LINK_RE.test(label))) continue
    let abs
    try {
      abs = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    if (seen.has(abs)) continue
    seen.add(abs)
    links.push({ url: abs, label: label.slice(0, 200) })
    if (links.length >= 300) break
  }
  const closed = CLOSED_SIGNAL_RE.test(text)
  const upcoming = !closed && UPCOMING_SIGNAL_RE.test(text)
  const open = !closed && !upcoming && OPEN_SIGNAL_RE.test(text)
  return {
    links,
    signals: { closed, upcoming, open, linkCount: links.length },
    hash: sha1ish(`${links.length}|${links.map((l) => l.url).sort().join(',')}|${closed}|${upcoming}`),
    textLength: text.length,
    text: text.slice(0, 4000),
  }
}

/** Status implied by page text. Never stronger than the evidence it came from. */
export function inferStatusFromText(text) {
  const t = String(text ?? '')
  if (CLOSED_SIGNAL_RE.test(t)) return 'CLOSED'
  if (UPCOMING_SIGNAL_RE.test(t)) return 'UPCOMING'
  if (OPEN_SIGNAL_RE.test(t)) return 'OPEN'
  return null
}

// ─── pasted-JD normalizer ────────────────────────────────────────────────────
/**
 * `字节跳动 数据分析实习生` → company `字节跳动`.
 * Only used when no company suffix was found, and only when the rest of the line
 * looks like a role, so a stray line of prose is not mistaken for an employer.
 */
function firstLineCompany(lines) {
  for (const line of lines.slice(0, 4)) {
    const m = /^([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9.·]{1,19})\s*[|｜\-–—:：]?\s*(.+)$/.exec(line)
    if (!m) continue
    const [, head, rest] = m
    if (/实习|工程师|分析师|产品|运营|研究员|开发|设计|顾问|助理|经理/.test(rest)) return head
  }
  return null
}

/**
 * Turn pasted JD / 招聘公告 text into a job record. Every derived field is either
 * explicit in the text or left null — the parser never guesses compensation,
 * conversion odds, or deadlines that are not written down.
 */
export function parsePastedJob(text, hints = {}) {
  const body = String(text ?? '')
  if (body.trim().length < 10) throw new Error('粘贴内容太短，无法识别')
  const firstLines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)
  const title = str(hints.title, 300)
    ?? firstLines.find((l) => /实习|工程师|分析师|产品|运营|研究员|开发|设计|顾问|助理/.test(l))
    ?? firstLines[0]
  const company = str(hints.company, 200)
    ?? /([\u4e00-\u9fff]{2,20}(?:公司|集团|银行|证券|基金|科技|研究院|事务所))/.exec(body)?.[1]
    ?? firstLineCompany(firstLines)
    ?? null
  if (!company) throw new Error('未识别到公司名，请在 hints.company 里提供')
  const urlMatch = /https?:\/\/[^\s"'<>）)]+/.exec(body)

  return normalizeJob({
    company,
    title: title ?? '未命名岗位',
    description: body.slice(0, 15000),
    requirements: body.slice(0, 15000),
    location: hints.location ?? null,
    internshipType: hints.internshipType ?? parseInternshipType(body),
    remoteType: hints.remoteType ?? parseRemoteType(body),
    daysPerWeek: hints.daysPerWeek ?? parseDaysPerWeek(body),
    gradeLimit: hints.gradeLimit ?? parseGradeLimit(body),
    deadline: hints.deadline ?? parseDeadline(body),
    salaryText: hints.salary ?? /((?:[0-9]{2,4})\s*[-~]\s*[0-9]{2,4}\s*(?:元|块)?\s*\/?\s*(?:天|日|月|小时))/.exec(body)?.[1] ?? null,
    department: hints.department ?? null,
    skills: extractSkills(body),
    url: hints.url ?? urlMatch?.[0] ?? null,
    conversionPossible: hints.conversionPossible,
    publishedAt: hints.publishedAt ?? null,
    tags: hints.tags ?? [],
  })
}

// ─── connector catalogue ─────────────────────────────────────────────────────
/**
 * Registered connectors and why the rest are absent. `accessMode: 'blocked'`
 * entries exist only to make the limitation visible in the Source Health panel.
 */
export const CONNECTOR_META = [
  {
    connector: 'official_careers',
    displayName: '企业官方招聘页 (Careers / 校招官网)',
    accessMode: 'public_page',
    capabilities: ['checkAvailability', 'search', 'fetch', 'normalize', 'save', 'reportStatus'],
    needsUser: false,
    enabled: true,
    rateLimitNote: '串行请求，默认间隔 2.5s；先读 robots.txt；不绕过任何访问控制',
  },
  {
    connector: 'web_search',
    displayName: '合规搜索发现 (Harness 搜索提供方)',
    accessMode: 'search_snippet',
    capabilities: ['checkAvailability', 'search'],
    needsUser: false,
    enabled: true,
    rateLimitNote: '复用 Harness 已配置的搜索提供方，只取链接与摘要，不抓正文',
  },
  {
    connector: 'manual',
    displayName: '手动粘贴 / 用户导入',
    accessMode: 'user_input',
    capabilities: ['normalize', 'validate', 'save'],
    needsUser: true,
    enabled: true,
    rateLimitNote: '无网络请求，始终可用（不可接入平台的通用兜底）',
  },
  {
    connector: 'job_board',
    displayName: '第三方招聘平台 (实习僧 / BOSS / 牛客 / 智联 …)',
    accessMode: 'blocked',
    capabilities: [],
    needsUser: true,
    enabled: false,
    rateLimitNote: '无官方开放接口，且自动抓取违反平台条款与反爬规则。请用「手动粘贴」导入你在平台上合法看到的内容。',
  },
  {
    connector: 'social_platform',
    displayName: '论坛与社区 (小红书 / 脉脉 / 知乎 / 一亩三分地 …)',
    accessMode: 'blocked',
    capabilities: [],
    needsUser: true,
    enabled: false,
    rateLimitNote: '均需登录且禁止自动化采集。系统提供搜索关键词与公开链接，正文请手动粘贴或导入你合法导出的资料。',
  },
]

export function connectorMeta(name) {
  return CONNECTOR_META.find((c) => c.connector === name) ?? null
}

/** Search-query suggestions for platforms we cannot crawl (spec §3.5). */
export function suggestSocialQueries({ company, role, year }) {
  const y = year ?? new Date().getFullYear()
  const targets = [
    { platform: '小红书', template: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}` },
    { platform: '牛客', template: (q) => `https://www.nowcoder.com/search?query=${encodeURIComponent(q)}&type=post` },
    { platform: '知乎', template: (q) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(q)}` },
    { platform: '脉脉', template: (q) => `https://maimai.cn/web/search_center?type=post&query=${encodeURIComponent(q)}` },
    { platform: 'V2EX', template: (q) => `https://www.google.com/search?q=site%3Av2ex.com+${encodeURIComponent(q)}` },
    { platform: '一亩三分地', template: (q) => `https://www.google.com/search?q=site%3A1point3acres.com+${encodeURIComponent(q)}` },
  ]
  const queries = [
    `${company ?? ''} ${role ?? ''} 实习 面经 ${y}`.trim(),
    `${company ?? ''} 实习 体验 转正`.trim(),
    `${company ?? ''} ${role ?? ''} 招聘 bar 学历`.trim(),
    `${company ?? ''} 实习 笔试 题目`.trim(),
  ].filter((q) => q.replace(/\s/g, '').length > 2)
  return {
    queries,
    links: targets.flatMap((t) => queries.slice(0, 3).map((q) => ({ platform: t.platform, query: q, url: t.template(q) }))),
    note: '这些链接只用于你自己打开浏览；系统不会自动抓取其正文。看到有用的内容请手动粘贴，系统会做结构化并标注证据等级。',
  }
}
