// 站点采集配置：小红书（面经/笔记）、BOSS直聘、前程无忧（岗位）。
//
// 统一走我们已验证的合规路径：用专用浏览器打开用户**已登录**的页面，读页面自己发出的
// JSON 响应（签名由站点前端自己生成，我们不破解），再解析成结构化数据。
//
// 参考调研（2026-11）：
//   - boss-zhipin-scraper：纯 CDP 连接本地已登录 Chrome，直接读 zhipin 搜索接口 JSON，绕过字体反爬
//   - MediaCrawler：Playwright + JS 逆向签名（我们不走这条，避免破解签名）
//   - xhs_one_spider：GUI + cookie 调 web 接口（签名封装在外部，源码未完全公开）
//   - 其余多为 Selenium/DrissionPage 自动化
// 结论：CDP 复用登录态是最稳、最不触碰「破解签名/绕过登录」红线的做法，也是我们已有的能力。

const NOTE_KIND = 'note'
const JOB_KIND = 'job'

function asText(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 2) return null
  if (Array.isArray(value)) {
    const parts = value.map((v) => asText(v, depth + 1)).filter(Boolean)
    return parts.length ? parts.join(' ') : null
  }
  if (typeof value === 'object') {
    for (const k of ['name', 'title', 'text', 'label', 'desc', 'value']) {
      const t = asText(value[k], depth + 1)
      if (t) return t
    }
  }
  return null
}

/** 广度优先遍历 JSON，找满足 predicate 的对象。 */
function walkObjects(payload, predicate, { maxNodes = 200000 } = {}) {
  const out = []
  const queue = [payload]
  let visited = 0
  while (queue.length && visited < maxNodes) {
    const node = queue.shift()
    visited += 1
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
      continue
    }
    if (predicate(node)) out.push(node)
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return out
}

function first(obj, keys) {
  for (const k of keys) {
    const t = asText(obj?.[k])
    if (t) return t
  }
  return null
}

// ─── 小红书：笔记（面经/岗位线索）────────────────────────────────────────────
export function parseXhsNotes(payload) {
  const seen = new Set()
  const notes = []
  const looks = (n) => {
    const c = n.note_card ?? n.noteCard ?? null
    // 有 note_card 包裹：以卡片标题为准；否则要求「节点自带 id + 标题」，
    // 避免把卡片内部的 user/interact 子对象重复算成笔记。
    if (c) return Boolean(first(c, ['display_title', 'displayTitle', 'title']))
    return Boolean(first(n, ['id', 'note_id', 'noteId']) && first(n, ['display_title', 'displayTitle', 'title']))
  }
  for (const n of walkObjects(payload, looks)) {
    const card = n.note_card ?? n.noteCard ?? n.note ?? n
    const id = first(n, ['id', 'note_id', 'noteId']) ?? first(card, ['note_id', 'noteId', 'id'])
    const title = first(card, ['display_title', 'displayTitle', 'title']) ?? first(n, ['display_title', 'title'])
    const key = id ? `id:${id}` : `t:${title}`
    if (seen.has(key)) continue
    seen.add(key)
    notes.push({
      platform: 'xiaohongshu',
      id: id ?? null,
      title: title ?? '(无标题)',
      desc: first(card, ['desc', 'description', 'content']),
      author: asText(card.user?.nickname ?? card.user?.nickName ?? n.user?.nickname),
      liked: first(card, ['liked_count', 'likedCount']) ?? asText(card.interact_info?.liked_count),
      publishedAt: first(card, ['time', 'publish_time', 'publishTime']) ?? asText(n.note_card?.time),
      url: id ? `https://www.xiaohongshu.com/explore/${id}` : null,
    })
  }
  return notes
}

// ─── BOSS直聘：岗位 ─────────────────────────────────────────────────────────
export function parseBossJobs(payload) {
  const seen = new Set()
  const jobs = []
  const looks = (n) => Boolean(first(n, ['jobName', 'job_name', 'positionName']) && (first(n, ['brandName', 'companyName', 'salaryDesc', 'cityName'])))
  for (const n of walkObjects(payload, looks)) {
    const title = first(n, ['jobName', 'job_name', 'positionName'])
    const company = first(n, ['brandName', 'companyName', 'company_name'])
    const code = first(n, ['encryptJobId', 'encrypt_job_id', 'jobId'])
    const key = code ? `c:${code}` : `t:${company}|${title}`
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push({
      platform: 'boss',
      jobCode: code ?? null,
      title,
      company,
      location: first(n, ['cityName', 'city_name', 'city']),
      salaryText: first(n, ['salaryDesc', 'salary_desc', 'salary']),
      experience: first(n, ['jobExperience', 'experience']),
      degree: first(n, ['jobDegree', 'degree']),
      url: code ? `https://www.zhipin.com/job_detail/${code}.html` : first(n, ['jobUrl', 'url']),
    })
  }
  return jobs
}

// ─── 前程无忧 51job：岗位 ──────────────────────────────────────────────────
export function parse51Jobs(payload) {
  const seen = new Set()
  const jobs = []
  const looks = (n) => Boolean(first(n, ['jobName', 'jobTitle', 'job_name']) && first(n, ['companyName', 'fullCompanyName', 'provideSalaryString', 'jobAreaString', 'workArea']))
  for (const n of walkObjects(payload, looks)) {
    const title = first(n, ['jobName', 'jobTitle', 'job_name'])
    const company = first(n, ['companyName', 'fullCompanyName', 'company_name'])
    const code = first(n, ['jobId', 'job_id', 'jobCode'])
    const href = first(n, ['jobHref', 'jobUrl', 'job_href', 'url'])
    const key = code ? `c:${code}` : (href ? `u:${href}` : `t:${company}|${title}`)
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push({
      platform: '51job',
      jobCode: code ?? null,
      title,
      company,
      location: first(n, ['jobAreaString', 'workArea', 'jobArea', 'cityName']),
      salaryText: first(n, ['provideSalaryString', 'salary', 'salaryString']),
      experience: first(n, ['workYearString', 'workYear']),
      degree: first(n, ['degreeString', 'degree']),
      publishedAt: first(n, ['issueDateString', 'issueDate']),
      url: href ?? (code ? `https://jobs.51job.com/${code}.html` : null),
    })
  }
  return jobs
}

// ─── OfferShow：校招薪资爆料 ────────────────────────────────────────────────
export function parseOffershow(payload) {
  const seen = new Set()
  const reports = []
  const looks = (n) => Boolean(first(n, ['company', 'companyName', 'company_name']) &&
    first(n, ['salary', 'salaryDesc', 'monthSalary', 'salaryString', 'totalSalary']) &&
    first(n, ['position', 'jobName', 'positionName', 'jobTitle']))
  for (const n of walkObjects(payload, looks)) {
    const company = first(n, ['company', 'companyName', 'company_name'])
    const position = first(n, ['position', 'jobName', 'positionName', 'jobTitle'])
    const salary = first(n, ['salary', 'salaryDesc', 'monthSalary', 'salaryString', 'totalSalary'])
    const key = `${company}|${position}|${salary}`
    if (seen.has(key)) continue
    seen.add(key)
    reports.push({
      platform: 'offershow',
      company,
      title: position,
      salary,
      city: first(n, ['city', 'cityName', 'workCity']),
      degree: first(n, ['degree', 'education', 'degreeName']),
      year: first(n, ['year', 'graduationYear', 'recruitYear']),
      url: first(n, ['url', 'link', 'detailUrl']),
    })
  }
  return reports
}

/** 站点配置。searchUrl 只用于打开搜索页，真正的数据由页面自己请求。 */
export const SITE_PROFILES = {
  xhs: {
    key: 'xhs',
    label: '小红书（笔记/面经）',
    kind: NOTE_KIND,
    loginUrl: 'https://www.xiaohongshu.com',
    patterns: ['note', 'search', 'feed', 'api'],
    searchUrl: ({ keyword }) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword ?? '')}&type=51`,
    parse: parseXhsNotes,
    note: '记得在浏览器里先登录小红书；搜出来的笔记会被当作「面经/岗位线索」导入资料库。',
  },
  boss: {
    key: 'boss',
    label: 'BOSS直聘（岗位）',
    kind: JOB_KIND,
    loginUrl: 'https://www.zhipin.com',
    patterns: ['joblist', 'zpgeek', 'job', 'search'],
    searchUrl: ({ keyword, city }) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword ?? '')}${city ? `&city=${encodeURIComponent(city)}` : ''}`,
    parse: parseBossJobs,
    note: '参考 boss-zhipin-scraper 的 CDP 思路：复用登录态读搜索接口 JSON，避开字体反爬。',
  },
  '51job': {
    key: '51job',
    label: '前程无忧（岗位）',
    kind: JOB_KIND,
    loginUrl: 'https://we.51job.com',
    patterns: ['job', 'search', 'offer', 'pc'],
    searchUrl: ({ keyword }) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword ?? '')}&searchType=2`,
    parse: parse51Jobs,
    note: '前程无忧新版为 SPA，登录后在搜索页抓其自身 XHR。',
  },
  offershow: {
    key: 'offershow',
    label: 'OfferShow（薪资爆料）',
    kind: 'salary',
    loginUrl: 'https://www.offershow.cn',
    patterns: ['salary', 'offer', 'list', 'query', 'api', 'search'],
    searchUrl: ({ keyword }) => `https://www.offershow.cn/?keyword=${encodeURIComponent(keyword ?? '')}`,
    parse: parseOffershow,
    note: '薪资为匿名爆料（证据 C，仅供参考）。若站内搜索在别的路由，先在页面搜好，再用 useOpenTab=true 从该页抓。',
  },
}

export function getSiteProfile(site) {
  return SITE_PROFILES[String(site ?? '').toLowerCase()] ?? null
}
