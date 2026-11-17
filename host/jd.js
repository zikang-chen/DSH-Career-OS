// 按需补全 JD 正文。
//
// 为什么需要：有些站点的「列表接口」只返回标题、地点、批次（腾讯的 searchPosition），
// 正文要另调「详情接口」，而且用的是另一个 id（postId）。不补的话，岗位库里就只有标题，
// 面试前想看当时要求就抓瞎，改简历也没有依据。
//
// 设计：按站点注册「详情提供方」，每个提供方说清楚「怎么拼 URL、怎么从响应里取字段」。
// 认不出的站点就诚实返回 unsupported，不猜接口。
import { capturePageText } from './browser.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// 长正文不能只保留开头一两千字；同时限制单字段大小，避免整页导航无限落库。
const MAX_JD_TEXT_LENGTH = 20000
const MIN_JD_BODY_LENGTH = 40
const DESCRIPTION_HEADINGS = new Set(['职位信息', '岗位职责', '职位职责', '职位描述', '工作职责', '工作内容', '岗位描述', '职责描述', '主要职责', 'job description', 'responsibilities'])
const REQUIREMENT_HEADINGS = new Set(['任职要求', '岗位要求', '任职资格', '职位要求', '招聘要求', 'requirements', 'qualifications'])
// 只认独立标题（或标题后的冒号），不把「登录后查看岗位职责」里的词当标题。
const JD_HEADING_RE = /^[\t ]*(?:[一二三四五六七八九十\d]+[、.．)）][\t ]*)?[【\[（(]?(职位信息|岗位职责|职位职责|职位描述|工作职责|工作内容|岗位描述|职责描述|主要职责|任职要求|岗位要求|任职资格|职位要求|招聘要求|Job Description|Responsibilities|Requirements|Qualifications|福利待遇|福利|公司信息|公司介绍|公司简介|企业介绍|联系方式|工作地址|上班地址|投递方式|投递|推荐职位|相似职位|工商信息)[】\]）)]?[\t ]*(?:[：:][\t ]*|(?=\n|$))/gim

const cleanText = (text) => String(text ?? '').replace(/\r/g, '').replace(/[\u00a0\u200b]/g, ' ').trim()
const bodyLength = (text) => (String(text ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length
const emptyJd = (error) => ({ description: null, requirements: null, error })

/** 识别明确的访问阻断提示；普通导航里的「登录 / 注册」不等于登录墙。 */
function blockedPageReason({ url, title, text } = {}) {
  if (url) {
    let parsed
    try { parsed = new URL(url) } catch { return '详情页返回了无效 URL' }
    if (!/^https?:$/.test(parsed.protocol)) return '详情页未正常加载'
    if (/(^|\.)(?:passport|login|captcha|verify)\./i.test(parsed.hostname)
      || /\/(?:login|signin|sign-in|passport|captcha|verify|security-check)(?:[/.]|$)|\/web\/user(?:\/|$)/i.test(parsed.pathname)) {
      return '详情页跳转到了登录或安全验证页'
    }
  }
  const pageTitle = cleanText(title)
  if (/^(?:(?:BOSS直聘|前程无忧|51job)\s*[-_|—]?\s*)?(?:用户登录|账号登录|登录|登陆|注册|安全验证|人机验证|验证码|访问受限|访问异常|页面不存在|页面未找到|出错了|login|sign in|security check|verification|captcha|access denied|forbidden|too many requests|page not found|internal server error|bad gateway|service unavailable|error|404|403|429|500|502|503)(?:\s*[-_|—].*|\s*)$/i.test(pageTitle)) {
    return '详情页标题显示登录、验证或错误页面'
  }
  const raw = [pageTitle, cleanText(text)].filter(Boolean).join('\n')
  if (/(?:请(?:您)?(?:先)?|需要)(?:登录|登陆)(?:后|再|以|查看|才能|[，。！!；;：:\s]|$)|(?:登录|登陆)(?:后|才能|即可)(?:可)?(?:查看|浏览|继续|获取|访问)|(?:尚未|未)(?:登录|登陆)|(?:扫码|账号密码|短信验证码)(?:登录|登陆)/.test(raw)
    || /please (?:log\s?in|sign\s?in)|(?:log\s?in|sign\s?in) (?:to|before you can) (?:view|continue|access|read)/i.test(raw)) {
    return '详情页需要登录，未读取到可验证的 JD 正文'
  }
  if (/(?:拖动|滑动)(?:下方)?(?:滑块|验证)|(?:请|需要).{0,20}(?:完成|进行)(?:安全|人机)?验证|请输入.{0,10}验证码|验证码.{0,8}(?:错误|失效)|^(?:安全验证|人机验证|滑块验证)\s*$/m.test(raw)
    || /verify (?:that )?you are (?:a )?human|checking your browser|(?:complete|solve|enter).{0,20}captcha/i.test(raw)) {
    return '详情页需要验证码或安全验证'
  }
  if (/(?:访问|请求|操作)(?:过于|太|过)?频繁|(?:请求|访问)(?:次数|频率)(?:过多|过高)|访问(?:已被|被)?(?:限制|拒绝|拦截)|访问受限|访问异常|异常访问|请求被拦截|系统繁忙|服务(?:暂时|暂)?不可用|(?:网络|系统)(?:异常|错误).{0,15}(?:重试|再试)|页面(?:不存在|未找到|走丢|出错)|(?:职位|岗位)(?:已下架|已关闭|不存在|已失效|已被删除)/.test(raw)
    || /access denied|too many requests|rate limit(?:ed| exceeded)|unusual traffic|\b(?:403\s+forbidden|404\s+not found|429\s+too many requests|500\s+internal server error|502\s+bad gateway|503\s+service unavailable)\b|^\s*(?:403|404|429|500|502|503)\s*$/im.test(raw)) {
    return '详情页显示限流、访问错误或职位已失效'
  }
  return null
}

/** 仅从明确职责/要求标题提取正文；无标题、标题空壳或错误页均留空，不猜最长段落。 */
export function extractJdFromText(text) {
  const raw = cleanText(text)
  if (!raw) return emptyJd('详情页正文为空')
  const blocked = blockedPageReason({ text: raw })
  if (blocked) return emptyJd(blocked)
  const headings = [...raw.matchAll(JD_HEADING_RE)]
  const parts = { description: [], requirements: [] }
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]
    const label = heading[1].toLowerCase()
    const field = DESCRIPTION_HEADINGS.has(label) ? 'description' : REQUIREMENT_HEADINGS.has(label) ? 'requirements' : null
    if (!field) continue
    const body = raw.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? raw.length).trim()
    if (body) parts[field].push(body)
  }
  const description = parts.description.join('\n\n').slice(0, MAX_JD_TEXT_LENGTH) || null
  const requirements = parts.requirements.join('\n\n').slice(0, MAX_JD_TEXT_LENGTH) || null
  if (!headings.some((heading) => DESCRIPTION_HEADINGS.has(heading[1].toLowerCase()) || REQUIREMENT_HEADINGS.has(heading[1].toLowerCase()))) {
    return emptyJd('详情页没有明确的职责或要求标题，不能猜测 JD 正文')
  }
  if (bodyLength(description) + bodyLength(requirements) < MIN_JD_BODY_LENGTH) {
    return emptyJd('职责或要求标题下的 JD 正文不足，不能只凭岗位标题入库')
  }
  return { description, requirements }
}

/** 只信任本 provider 明确登记的正文选择器，去重嵌套命中，不接受任意 sections 当来源。 */
function selectedJdText(page, selectors) {
  const allowed = new Set(selectors)
  const texts = [...new Set((Array.isArray(page.sections) ? page.sections : [])
    .filter((section) => allowed.has(section?.selector))
    .map((section) => cleanText(section.text)).filter(Boolean))]
  return texts.filter((text) => !texts.some((other) => other !== text && other.includes(text))).join('\n\n')
}

/** 已知站点的详情接口。id 用 postId 或 jobCode。 */
export const JD_PROVIDERS = [
  {
    key: 'tencent-campus',
    host: /(^|\.)join\.qq\.com$/,
    need: 'postId',
    mode: 'api',
    buildUrl: ({ postId }) => `https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId=${encodeURIComponent(postId)}`,
    referer: 'https://join.qq.com/post.html',
    pick: (json) => {
      const data = json?.data ?? {}
      if (!data || (!data.desc && !data.request)) return null
      return {
        description: String(data.desc ?? '').trim() || null,
        requirements: String(data.request ?? '').trim() || null,
        location: Array.isArray(data.workCityList) && data.workCityList.length ? data.workCityList.join(' ') : null,
        title: String(data.title ?? '').trim() || null,
        department: String(data.tidName ?? '').trim() || null,
      }
    },
  },
  // 只登记正文容器，不用 body / main / 职位标题之类的宽泛节点充当 JD。
  {
    key: '51job-page', host: /(^|\.)51job\.com$/, mode: 'page', need: 'url',
    selectors: ['.bmsg.job_msg', '.job_msg', '.job-intro-content'],
  },
  {
    key: 'boss-page', host: /(^|\.)zhipin\.com$/, mode: 'page', need: 'url',
    selectors: ['.job-sec-text', '.job-sec .text'],
  },
]

/** 根据岗位的 apply_url / url 找提供方。 */
export function resolveJdProvider({ applyUrl, url, sourceUrl } = {}) {
  for (const candidate of [applyUrl, url, sourceUrl]) {
    if (!candidate) continue
    let parsed
    try {
      parsed = new URL(String(candidate))
    } catch {
      continue
    }
    for (const provider of JD_PROVIDERS) {
      if (provider.host.test(parsed.hostname)) return provider
    }
  }
  return null
}

/**
 * 抓一个岗位的 JD 正文。
 * @param {{provider:object, postId?:string, jobCode?:string, url?:string, dataDir?:string, timeoutMs?:number, captureText?:Function}} input
 * @returns {{ok:boolean, description?, requirements?, location?, title?, department?, error?:string, unsupported?:boolean}}
 */
export async function fetchJdDetail({ provider, postId, jobCode, url, dataDir, timeoutMs = 15000, captureText = capturePageText } = {}) {
  if (!provider) return { ok: false, unsupported: true, error: '这家公司的详情接口没有登记，无法自动补 JD' }

  if (provider.mode === 'page') {
    if (!url) return { ok: false, ...emptyJd('缺少岗位详情页 URL') }
    // 注入读取器的离线测试不需要浏览器目录；原有真实浏览器调用仍保留此校验。
    if (!dataDir && captureText === capturePageText) return { ok: false, ...emptyJd('缺少 dataDir（页面模式需要专用浏览器）') }
    const selectors = Array.isArray(provider.selectors) ? provider.selectors : []
    try {
      const page = await captureText({ dataDir, url, timeoutMs: Math.max(timeoutMs, 12000), selectors })
      if (!page?.ok || page.error) return { ok: false, ...emptyJd(page?.error ?? '页面读取失败') }
      const blocked = blockedPageReason({ url: page.url ?? url, title: page.title, text: page.text })
      if (blocked) return { ok: false, ...emptyJd(blocked) }
      if (page.url && provider.host && !provider.host.test(new URL(page.url).hostname)) {
        return { ok: false, ...emptyJd('详情页跳转到了其他站点，不能作为该岗位的 JD 来源') }
      }
      const domText = selectedJdText(page, selectors)
      const domBlocked = blockedPageReason({ text: domText })
      if (domBlocked) return { ok: false, ...emptyJd(domBlocked) }
      let cut = extractJdFromText(domText || page.text)
      // 已知正文 DOM 可能不含标题，可完整保存；有标题但没有正文时不能绕过 strict 校验。
      const hasJdHeading = [...domText.matchAll(JD_HEADING_RE)]
        .some((heading) => DESCRIPTION_HEADINGS.has(heading[1].toLowerCase()) || REQUIREMENT_HEADINGS.has(heading[1].toLowerCase()))
      if (domText && !hasJdHeading && bodyLength(domText) >= MIN_JD_BODY_LENGTH) {
        cut = { description: domText.slice(0, MAX_JD_TEXT_LENGTH), requirements: null }
      }
      if (!cut.description && !cut.requirements) return { ok: false, ...emptyJd(cut.error ?? '详情页没有可验证的 JD 正文') }
      return { ok: true, description: cut.description, requirements: cut.requirements, pageTitle: page.title ?? null }
    } catch (err) {
      return { ok: false, ...emptyJd(`页面读取失败：${String(err?.message ?? err)}`) }
    }
  }

  const idValue = provider.need === 'postId' ? postId : jobCode
  if (!idValue) {
    return { ok: false, error: provider.need === 'postId' ? '缺少 postId（列表接口没给，需要重新抓一次列表）' : '缺少岗位编号' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(provider.buildUrl({ postId, jobCode }), {
      headers: { 'user-agent': UA, accept: 'application/json', referer: provider.referer ?? '' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const json = await response.json()
    const picked = provider.pick(json)
    if (!picked) return { ok: false, error: '响应里没有 JD 正文（接口结构可能变了）' }
    return { ok: true, ...picked }
  } catch (err) {
    return { ok: false, error: controller.signal.aborted ? `超时（${timeoutMs}ms）` : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}
