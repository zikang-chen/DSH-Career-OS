// 按需补全 JD 正文。
//
// 为什么需要：有些站点的「列表接口」只返回标题、地点、批次（腾讯的 searchPosition），
// 正文要另调「详情接口」，而且用的是另一个 id（postId）。不补的话，岗位库里就只有标题，
// 面试前想看当时要求就抓瞎，改简历也没有依据。
//
// 设计：按站点注册「详情提供方」，每个提供方说清楚「怎么拼 URL、怎么从响应里取字段」。
// 认不出的站点就诚实返回 unsupported，不猜接口。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 已知站点的详情接口。id 用 postId 或 jobCode。 */
export const JD_PROVIDERS = [
  {
    key: 'tencent-campus',
    host: /(^|\.)join\.qq\.com$/,
    need: 'postId',
    buildUrl: ({ postId }) => `https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId=${encodeURIComponent(postId)}`,
    referer: 'https://join.qq.com/post.html',
    // 从响应里取字段。腾讯：data.desc / data.request / data.workCityList
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
 * @param {{provider:object, postId?:string, jobCode?:string, timeoutMs?:number}} input
 * @returns {{ok:boolean, description?, requirements?, location?, title?, department?, error?:string, unsupported?:boolean}}
 */
export async function fetchJdDetail({ provider, postId, jobCode, timeoutMs = 15000 } = {}) {
  if (!provider) return { ok: false, unsupported: true, error: '这家公司的详情接口没有登记，无法自动补 JD' }
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
