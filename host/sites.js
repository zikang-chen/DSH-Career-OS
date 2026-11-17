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

/** 广度优先遍历 JSON；命中卡片后可停止下钻，避免把其内部 card 再识别一次。 */
function walkObjects(payload, predicate, { maxNodes = 200000, pruneMatches = false } = {}) {
  const out = []
  const queue = [payload]
  const seen = new WeakSet()
  for (let index = 0; index < queue.length && index < maxNodes; index += 1) {
    const node = queue[index]
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
      continue
    }
    if (predicate(node)) {
      out.push(node)
      if (pruneMatches) continue
    }
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

/** 只接受原文给出的完整日期/时间，不把“昨天”等相对日期补成今天。 */
function normalizePublishedAt(value) {
  const text = asText(value)
  if (!text) return null
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (!match) match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[Tt ])/u.exec(text)
  if (match) {
    const [, year, month, day] = match
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    const checked = new Date(`${date}T00:00:00Z`)
    if (!Number.isFinite(checked.getTime()) || checked.toISOString().slice(0, 10) !== date) return null
    if (text === match[0] || /^\d{8}$/.test(text)) return date
    // 无时区的本地时间只保留已知日期，不擅自认定 UTC/本地时区。
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[Tt ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) {
      const clock = /[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
      return Number(clock[1]) < 24 && Number(clock[2]) < 60 && Number(clock[3] ?? 0) < 60 ? date : null
    }
    if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text)) return null
    const clock = /[Tt](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
    if (Number(clock[1]) >= 24 || Number(clock[2]) >= 60 || Number(clock[3] ?? 0) >= 60) return null
    const timestamp = Date.parse(text)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
  }
  // 仅识别常见的 Unix 秒/毫秒格式；0、年份或未说明单位的短数字不能当时间。
  if (/^(?:\d{10}|\d{13})$/.test(text)) {
    const timestamp = Number(text) * (text.length === 10 ? 1000 : 1)
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null
  }
  return null
}

function firstPublishedAt(objects, keys) {
  for (const obj of objects) {
    for (const key of keys) {
      const date = normalizePublishedAt(obj?.[key])
      if (date) return date
    }
  }
  return null
}

function sourceRecruitFields(node) {
  const keys = ['recruitType', 'recruit_type', 'recruitmentType', 'recruitment_type']
  const explicit = keys.map((key) => node[key]).find((value) => ['campus', 'social', 'intern'].includes(value))
  return {
    recruitType: explicit ?? null,
    // 保留已知字段原文，但不把 1/2/3 等不明数字枚举臆造为招聘类型。
    recruitTypeText: first(node, ['recruitTypeText', 'recruitTypeName', 'recruitmentTypeName', ...keys, 'jobTypeName', 'jobType']),
  }
}

function absoluteHttpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value, base)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

function bossLinks(node, code) {
  const supplied = first(node, ['jobUrl', 'job_url', 'url'])
  const detail = absoluteHttpUrl(supplied, 'https://www.zhipin.com') ??
    (code ? `https://www.zhipin.com/job_detail/${encodeURIComponent(code)}.html` : null)
  if (!detail) return { url: null, detailUrl: null }
  const native = new URL(detail)
  // 只复用页面响应中真实提供的字段，不伪造 securityId / lid。
  for (const key of ['securityId', 'lid']) {
    if (typeof node[key] === 'string' && node[key].trim() && !native.searchParams.has(key)) native.searchParams.set(key, node[key])
  }
  const publicUrl = new URL(native)
  publicUrl.username = ''
  publicUrl.password = ''
  for (const key of [...publicUrl.searchParams.keys()]) {
    if (/^(?:security_?id|lid|session_?id|session|(?:access|refresh|auth|sso)?_?token|__zp_stoken__|cookie|authorization|ticket)$/i.test(key)) publicUrl.searchParams.delete(key)
  }
  return { url: publicUrl.href, detailUrl: native.href }
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
  for (const n of walkObjects(payload, looks, { pruneMatches: true })) {
    const card = n.note_card ?? n.noteCard ?? n
    const id = first(card, ['note_id', 'noteId', 'id']) ?? first(n, ['note_id', 'noteId', 'id'])
    const title = first(card, ['display_title', 'displayTitle', 'title']) ?? first(n, ['display_title', 'title'])
    const key = id ? `id:${id}` : `t:${title}`
    if (seen.has(key)) continue
    seen.add(key)
    const link = id ? new URL(`https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`) : null
    const token = [n.xsec_token, n.xsecToken, card.xsec_token, card.xsecToken].find((value) => typeof value === 'string' && value.trim())
    const source = [n.xsec_source, n.xsecSource, card.xsec_source, card.xsecSource].find((value) => typeof value === 'string' && value.trim())
    if (link && token) link.searchParams.set('xsec_token', token)
    if (link && token && source) link.searchParams.set('xsec_source', source)
    notes.push({
      platform: 'xiaohongshu',
      id: id ?? null,
      title: title ?? '(无标题)',
      desc: first(card, ['desc', 'description', 'content']),
      author: asText(card.user?.nickname ?? card.user?.nickName ?? n.user?.nickname),
      liked: first(card, ['liked_count', 'likedCount']) ?? asText(card.interact_info?.liked_count),
      publishedAt: firstPublishedAt([card, n], ['publishedAt', 'time', 'publish_time', 'publishTime']),
      media: { images: (Array.isArray(card.image_list) ? card.image_list : Array.isArray(card.imageList) ? card.imageList : []).map((image,index)=>({index:index+1,url:image.url_default??image.urlDefault??image.url_pre??image.url??null,width:image.width??null,height:image.height??null})).filter(image=>image.url),
        type: card.type??null, textStatus: 'not-ocr-processed' },
      url: link?.href ?? null,
    })
  }
  return notes
}

// ─── BOSS直聘：岗位 ─────────────────────────────────────────────────────────
export function parseBossJobs(payload) {
  const seen = new Set()
  const jobs = []
  const looks = (n) => Boolean(first(n, ['jobName', 'job_name', 'positionName']) && (first(n, ['brandName', 'companyName', 'salaryDesc', 'cityName'])))
  for (const n of walkObjects(payload, looks, { pruneMatches: true })) {
    const title = first(n, ['jobName', 'job_name', 'positionName'])
    const company = first(n, ['brandName', 'companyName', 'company_name'])
    const code = first(n, ['encryptJobId', 'encrypt_job_id', 'jobId'])
    const key = code ? `c:${code}` : `t:${company}|${title}`
    if (seen.has(key)) continue
    seen.add(key)
    const links = bossLinks(n, code)
    const job = {
      platform: 'boss',
      jobCode: code ?? null,
      title,
      company,
      location: first(n, ['cityName', 'city_name', 'city']),
      salaryText: first(n, ['salaryDesc', 'salary_desc', 'salary']),
      experience: first(n, ['jobExperience', 'experience', 'experienceName']),
      degree: first(n, ['jobDegree', 'degree', 'degreeName']),
      description: first(n, ['description', 'jobDescription', 'jobDesc', 'jobDescribe', 'jobContent']),
      requirements: first(n, ['requirements', 'jobRequirements', 'jobRequirement', 'jobRequire', 'qualification', 'qualifications']),
      publishedAt: firstPublishedAt([n], ['publishedAt', 'publishTime', 'publish_time', 'createTime']),
      ...sourceRecruitFields(n),
      url: links.url,
    }
    // 临时详情访问上下文不可进入日志/preview/持久化；调用者直接使用 detailUrl 抓 JD。
    Object.defineProperty(job, 'detailUrl', { value: links.detailUrl, enumerable: false })
    for (const field of ['securityId', 'lid', 'encryptBossId', 'encryptBrandId', 'sessionId']) {
      if (n[field] !== undefined) Object.defineProperty(job, field, { value: n[field], enumerable: false })
    }
    jobs.push(job)
  }
  return jobs
}

// ─── 前程无忧 51job：岗位 ──────────────────────────────────────────────────
export function parse51Jobs(payload) {
  const seen = new Set()
  const jobs = []
  const looks = (n) => Boolean(first(n, ['jobName', 'jobTitle', 'job_name']) && first(n, ['companyName', 'fullCompanyName', 'provideSalaryString', 'jobAreaString', 'workArea']))
  for (const n of walkObjects(payload, looks, { pruneMatches: true })) {
    const title = first(n, ['jobName', 'jobTitle', 'job_name'])
    const company = first(n, ['companyName', 'fullCompanyName', 'company_name'])
    const code = first(n, ['jobId', 'job_id', 'jobCode'])
    const href = absoluteHttpUrl(first(n, ['jobHref', 'jobUrl', 'job_href', 'url']), 'https://jobs.51job.com')
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
      experience: first(n, ['workYearString', 'workYearName', 'workYear', 'experience']),
      degree: first(n, ['degreeString', 'degreeName', 'degree']),
      description: first(n, ['description', 'jobDescription', 'jobDescribe', 'jobDesc', 'jobContent']),
      requirements: first(n, ['requirements', 'jobRequirements', 'jobRequirement', 'jobRequire', 'qualification', 'qualifications']),
      publishedAt: firstPublishedAt([n], ['publishedAt', 'issueDateString', 'issueDate', 'publishTime']),
      ...sourceRecruitFields(n),
      // 详情路径包含地区等原站参数；没有响应链接时不猜造 /<jobId>.html。
      url: href,
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
  for (const n of walkObjects(payload, looks, { pruneMatches: true })) {
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
      publishedAt: firstPublishedAt([n], ['publishedAt', 'publishTime', 'publish_time', 'createTime']),
      url: first(n, ['url', 'link', 'detailUrl']),
    })
  }
  return reports
}

/** OfferShow「校招计划」列表（search_plan_vip）：公司+招聘标题+城市+年份+起止时间+公告链接。 */
export function parseOffershowPlans(payload) {
  const seen = new Set()
  const plans = []
  const looks = (node) => Boolean(first(node, ['recruit_title', 'recruitTitle']) && first(node, ['company_name', 'companyName']))
  for (const node of walkObjects(payload, looks, { pruneMatches: true })) {
    const title = first(node, ['recruit_title', 'recruitTitle'])
    const company = first(node, ['company_name', 'companyName'])
    const key = `${company}|${title}`
    if (seen.has(key)) continue
    seen.add(key)
    plans.push({
      platform: 'offershow',
      company,
      title,
      city: first(node, ['recruit_city', 'recruitCity']),
      year: first(node, ['recruit_year', 'recruitYear']),
      startsAt: firstPublishedAt([node], ['start_time', 'startTime']),
      endsAt: firstPublishedAt([node], ['end_time', 'endTime']),
      publishedAt: firstPublishedAt([node], ['publishedAt', 'publish_time', 'publishTime']),
      url: first(node, ['notice_url', 'noticeUrl']),
    })
  }
  return plans
}

const SEARCH_URLS = {
  xhs: ({ keyword }) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51`,
  boss: ({ keyword, city }) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}${city ? `&city=${encodeURIComponent(city)}` : ''}`,
  '51job': ({ keyword }) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword)}&searchType=2`,
  offershow: ({ keyword }) => `https://www.offershow.cn/?keyword=${encodeURIComponent(keyword)}`,
}

function siteSearchPlan(site, { keyword, city, recruitType } = {}) {
  const type = normalizeRecruitType(recruitType)
  const originalKeyword = asText(keyword) ?? ''
  let searchKeyword = originalKeyword
  const notes = []
  if (['boss', '51job'].includes(site) && type) {
    if (type === 'intern' && !/实习|\bintern(?:ship)?\b/i.test(searchKeyword)) searchKeyword = `${searchKeyword} 实习`.trim()
    if (type === 'campus' && !/校招|校园招聘|秋招|春招/.test(searchKeyword)) searchKeyword = `${searchKeyword} 校招`.trim()
    notes.push('招聘类型仅作关键词降级检索，不是站点原生过滤；结果必须逐条严格按招聘类型过滤。')
  }
  const keywordSearchVerified = SITE_PROFILES[site].keywordSearchVerified
  if (!keywordSearchVerified) notes.push('此页面后端未采用已知 keyword 参数，不能宣称关键词搜索成功；仅可在返回内容上本地严格相关性过滤。')
  return {
    url: SEARCH_URLS[site]({ keyword: searchKeyword, city }),
    keyword: originalKeyword,
    searchKeyword,
    recruitType: type,
    keywordSearchVerified,
    keywordApplied: keywordSearchVerified && Boolean(searchKeyword),
    nativeRecruitTypeFilter: false,
    requiresStrictRecruitTypeFilter: Boolean(type),
    notes,
  }
}

/** 站点配置。searchPlan 说明已知能力边界；searchUrl 不代表站点原生招聘类型过滤。 */
export const SITE_PROFILES = {
  xhs: {
    key: 'xhs',
    label: '小红书（笔记/面经）',
    kind: NOTE_KIND,
    loginUrl: 'https://www.xiaohongshu.com',
    patterns: ['search/notes'],
    prefer: 'search/notes',
    keywordSearchVerified: true,
    searchPlan: (options) => siteSearchPlan('xhs', options),
    searchUrl: (options) => siteSearchPlan('xhs', options).url,
    parse: parseXhsNotes,
    note: '记得在浏览器里先登录小红书；搜出来的笔记会被当作「面经/岗位线索」导入资料库。',
  },
  boss: {
    key: 'boss',
    label: 'BOSS直聘（岗位）',
    kind: JOB_KIND,
    loginUrl: 'https://www.zhipin.com',
    patterns: ['joblist', 'zpgeek', 'job', 'search'],
    prefer: 'joblist\\.json|zpgeek/search',
    keywordSearchVerified: true,
    searchPlan: (options) => siteSearchPlan('boss', options),
    searchUrl: (options) => siteSearchPlan('boss', options).url,
    parse: parseBossJobs,
    note: '参考 boss-zhipin-scraper 的 CDP 思路：复用登录态读搜索接口 JSON，避开字体反爬。',
  },
  '51job': {
    key: '51job',
    label: '前程无忧（岗位）',
    kind: JOB_KIND,
    loginUrl: 'https://we.51job.com',
    patterns: ['job', 'search', 'offer', 'pc'],
    prefer: 'search-pc|job/search',
    searchUi: '#keywordInput',
    keywordSearchVerified: true,
    searchPlan: (options) => siteSearchPlan('51job', options),
    searchUrl: (options) => siteSearchPlan('51job', options).url,
    parse: parse51Jobs,
    note: '前程无忧新版为 SPA，登录后在搜索页抓其自身 XHR。',
  },
  offershow: {
    key: 'offershow',
    label: 'OfferShow（校招计划/薪资）',
    kind: 'plan',
    loginUrl: 'https://www.offershow.cn',
    patterns: ['search_plan', 'plan', 'offer', 'salary', 'api', 'list'],
    prefer: 'search_plan|/plan|salary',
    searchUi: 'input[placeholder="搜索公司"]',
    keywordSearchVerified: false,
    searchPlan: (options) => siteSearchPlan('offershow', options),
    searchUrl: (options) => siteSearchPlan('offershow', options).url,
    parse: (payload) => {
      const plans = parseOffershowPlans(payload)
      return plans.length ? plans : parseOffershow(payload)
    },
    note: '首页后端未采用已知 keyword 参数，默认会返回无关首页数据；只能本地严格相关性过滤，不能宣称站点关键词搜索成功。薪资爆料多需登录，属 C 级证据。',
  },
}

SITE_PROFILES.nowcoder = {
  key: 'nowcoder', label: '牛客（讨论/面经）', kind: 'note', loginUrl: 'https://www.nowcoder.com',
  patterns: ['search', 'discuss'], prefer: 'search|discuss', keywordSearchVerified: true,
  searchUrl: ({keyword,recruitType}) => { normalizeRecruitType(recruitType); return `https://www.nowcoder.com/search?query=${encodeURIComponent(keyword??'')}&type=post` },
  searchPlan: ({keyword,recruitType}) => { normalizeRecruitType(recruitType); return {url:`https://www.nowcoder.com/search?query=${encodeURIComponent(keyword??'')}&type=post`,keyword,searchKeyword:keyword,keywordApplied:Boolean(keyword),keywordSearchVerified:true,nativeRecruitTypeFilter:false,notes:[]} },
  parse: () => [],
  note: '优先读取公开搜索页的帖子链接及详情正文；登录或验证时停止，岗位与面经不混用。',
}

export function getSiteProfile(site) {
  return SITE_PROFILES[String(site ?? '').toLowerCase()] ?? null
}

/** 公共筛选参数仅接受这三个枚举；unknown 仅是分类结果，不能作为筛选请求。 */
export function normalizeRecruitType(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && ['campus', 'social', 'intern'].includes(value)) return value
  throw new TypeError('recruitType 必须是 campus、social 或 intern')
}

/** 仅使用明确标记、岗位标题及数字年限的经验要求；学历和“经验不限”不是社招证据。 */
export function classifyRecruitType(item = {}) {
  const title = asText(item?.title) ?? ''
  const explicit = ['campus', 'social', 'intern'].includes(item?.recruitType) ? item.recruitType : null
  // 校招实习/暑期实习优先归实习；不把 international/internal 等当 intern。
  if (explicit === 'intern' || /实习|\bintern(?:ship)?\b/i.test(title)) return 'intern'
  if (explicit) return explicit
  if (/校招|校园招聘|秋招|春招|20\d{2}\s*届|\bcampus\s+(?:recruit(?:ment|ing)?|hiring)\b|\bnew[- ]grad(?:uate)?s?\b/i.test(title)) return 'campus'
  if (/社招|社会招聘|\bexperienced\s+hir(?:e|es|ing)\b/i.test(title)) return 'social'
  const experience = asText(item?.experience) ?? ''
  // 数字必须确实带“年/years”，不解释 workYear 等字段中的数字类型枚举。
  // 0年/0-1年/经验不限/应届可投均不能断言面向有经验的社招。
  if (/经验不限|不限经验|无(?:需|须)经验|无需工作经验|应届|no\s+experience|not\s+required/i.test(experience)) return 'unknown'
  const years = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:[-–—~至]\s*\d+(?:\.\d+)?\s*)?(?:\+\s*)?(?:年|years?\b)/i.exec(experience)
  return years && Number(years[1]) > 0 ? 'social' : 'unknown'
}

/** 严格过滤；未知类型不会混入社招。未指定过滤则保留原数组。 */
export function filterByRecruitType(items = [], recruitType) {
  const type = normalizeRecruitType(recruitType)
  return type ? items.filter((it) => classifyRecruitType(it) === type) : items
}

/** 数据源 connector → 登录入口 URL（用于设置页双击登录）。 */
export function loginUrlForConnector(connector) {
  switch (String(connector ?? '')) {
    case 'xhs':
    case 'social_platform':
      return SITE_PROFILES.xhs.loginUrl
    case 'boss':
    case 'job_board':
      return SITE_PROFILES.boss.loginUrl
    case '51job':
      return SITE_PROFILES['51job'].loginUrl
    case 'nowcoder':
      return SITE_PROFILES.nowcoder.loginUrl
    case 'offershow':
      return SITE_PROFILES.offershow.loginUrl
    default:
      return null
  }
}
