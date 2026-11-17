// 已知招聘系统（ATS）的公开岗位接口适配器。
//
// 这些接口是各平台自己对外发布的只读接口（官方文档可查），无需登录、无需 API Key，
// 属于「合法优先」里的第一档。字段形状按实测/官方文档映射，取不到的字段留空。
import { htmlToText } from './sources.js'
import { parseDeadline } from './domain.js'
import { sha1ish, str } from './util.js'

export const ATS_SPECS = {
  greenhouse: {
    label: 'Greenhouse',
    docUrl: 'https://developers.greenhouse.io/job-board.html',
    api: (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    hint: 'board token 就是看板地址里的那段，例如 boards.greenhouse.io/acme → acme',
  },
  lever: {
    label: 'Lever',
    docUrl: 'https://api.lever.co/v0/postings/{company}?mode=json',
    api: (token) => `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
    hint: 'company 就是 jobs.lever.co/acme 里的 acme',
  },
  ashby: {
    label: 'Ashby',
    docUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
    api: (token) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
    hint: 'job board name 就是 jobs.ashbyhq.com/acme 里的 acme',
  },
  smartrecruiters: {
    label: 'SmartRecruiters',
    docUrl: 'https://developers.smartrecruiters.com/',
    api: (token) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`,
    hint: 'company identifier 就是 jobs.smartrecruiters.com/acme 里的 acme',
  },
  workday: {
    label: 'Workday',
    docUrl: 'https://{tenant}.wd{number}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs',
    api: (token) => {
      const [tenant, wd, site] = String(token ?? '').split('/')
      if (!tenant || !wd || !site) return null
      return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`
    },
    hint: 'tenent/site 来自地址：acme.wd5.myworkdayjobs.com/External → token 填 acme/wd5/External',
    needsPost: true,
  },
}

/**
 * Work out which ATS a URL belongs to and what its token is.
 * @returns {{ats:string, token:string, spec:object, pageUrl:string}|null}
 */
export function detectAts(url) {
  let parsed
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const parts = parsed.pathname.split('/').filter(Boolean)

  if (host.endsWith('greenhouse.io')) {
    const token = host.startsWith('boards-api.') ? parts[2] : parts[0] === 'embed' ? parts[2] : parts[0]
    if (token && token !== 'v1' && token !== 'boards') return { ats: 'greenhouse', token, spec: ATS_SPECS.greenhouse, pageUrl: url }
  }
  if (host === 'api.lever.co' || host.endsWith('lever.co')) {
    const token = host === 'api.lever.co' ? parts[2] : parts[0]
    if (token) return { ats: 'lever', token, spec: ATS_SPECS.lever, pageUrl: url }
  }
  if (host.endsWith('ashbyhq.com')) {
    const token = host === 'api.ashbyhq.com' ? parts[3] : parts[0]
    if (token) return { ats: 'ashby', token, spec: ATS_SPECS.ashby, pageUrl: url }
  }
  if (host.endsWith('smartrecruiters.com')) {
    const token = host === 'api.smartrecruiters.com' ? parts[3] : parts[0]
    if (token) return { ats: 'smartrecruiters', token, spec: ATS_SPECS.smartrecruiters, pageUrl: url }
  }
  const workday = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(host)
  if (workday) {
    const [, tenant, wd] = workday
    const site = parts[0] && parts[0] !== 'wday' ? parts[0] : 'External'
    return { ats: 'workday', token: `${tenant}/${wd}/${site}`, spec: ATS_SPECS.workday, pageUrl: url }
  }
  return null
}

function cleanText(value, max = 20000) {
  if (!value) return null
  const text = /<[a-z][\s\S]*>/i.test(String(value)) ? htmlToText(String(value)) : String(value)
  return str(text.replace(/\s+\n/g, '\n'), max)
}

// ─── per-ATS normalizers ─────────────────────────────────────────────────────
function fromGreenhouse(json) {
  const rows = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : []
  return rows.map((job) => ({
    title: str(job.title ?? job.name, 200),
    url: str(job.absolute_url, 1000),
    location: str(job.location?.name, 200),
    department: str(job.departments?.[0]?.name, 200),
    jobCode: job.id ? String(job.id) : null,
    description: cleanText(job.content),
    publishedAt: str(job.first_published ?? job.updated_at, 40),
    via: 'ats:greenhouse',
  }))
}

function fromLever(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.postings) ? json.postings : []
  return rows.map((job) => ({
    title: str(job.text ?? job.title, 200),
    url: str(job.hostedUrl ?? job.applyUrl, 1000),
    location: str(job.categories?.location, 200),
    department: str(job.categories?.team ?? job.categories?.department, 200),
    jobCode: job.id ? String(job.id) : null,
    description: cleanText(job.descriptionPlain ?? job.description),
    publishedAt: job.createdAt ? new Date(Number(job.createdAt)).toISOString() : null,
    via: 'ats:lever',
  }))
}

function fromAshby(json) {
  const rows = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : []
  return rows.map((job) => ({
    title: str(job.title ?? job.name, 200),
    url: str(job.jobUrl ?? job.applyUrl, 1000),
    location: str(job.location ?? job.locationName, 200),
    department: str(job.department ?? job.team, 200),
    jobCode: job.id ? String(job.id) : null,
    description: cleanText(job.descriptionPlain ?? job.descriptionHtml ?? job.description),
    publishedAt: str(job.publishedAt ?? job.updatedAt, 40),
    via: 'ats:ashby',
  }))
}

function fromSmartRecruiters(json) {
  const rows = Array.isArray(json?.content) ? json.content : []
  return rows.map((job) => ({
    title: str(job.name ?? job.title, 200),
    url: job.id ? `https://jobs.smartrecruiters.com/${json?.company?.identifier ?? ''}/${job.id}` : null,
    location: str(job.location?.city ?? job.location?.fullLocation, 200),
    department: str(job.department?.label ?? job.function?.label, 200),
    jobCode: str(job.refNumber ?? job.id, 120),
    description: cleanText(job.jobAd?.sections ? Object.values(job.jobAd.sections).map((s) => s?.text).filter(Boolean).join('\n') : null),
    publishedAt: str(job.releasedDate, 40),
    via: 'ats:smartrecruiters',
  }))
}

function fromWorkday(json) {
  const rows = Array.isArray(json?.jobPostings) ? json.jobPostings : []
  return rows.map((job) => ({
    title: str(job.title, 200),
    url: str(job.externalPath, 1000),
    location: str(job.locationsText ?? job.location, 200),
    department: null,
    jobCode: str(job.bulletFields?.[0] ?? job.jobRequisitionId, 120),
    description: null,
    publishedAt: str(job.postedOn, 40),
    via: 'ats:workday',
  }))
}

const NORMALIZERS = {
  greenhouse: fromGreenhouse,
  lever: fromLever,
  ashby: fromAshby,
  smartrecruiters: fromSmartRecruiters,
  workday: fromWorkday,
}

/** Normalize one ATS JSON payload into postings. */
export function normalizeAtsPayload(ats, json) {
  const normalizer = NORMALIZERS[String(ats ?? '').toLowerCase()]
  if (!normalizer) return []
  return normalizer(json).filter((p) => p.title)
}

/**
 * Fetch postings straight from a known ATS.
 * @returns {Promise<{ok:boolean, ats?:string, token?:string, postings:object[], error?:string, status?:number, apiUrl?:string, total?:number}>}
 */
export async function fetchAtsPostings({ ats, token, timeoutMs = 20_000, ua, query = '' }) {
  const spec = ATS_SPECS[String(ats ?? '').toLowerCase()]
  if (!spec) return { ok: false, postings: [], error: `未知的招聘系统：${ats}` }
  const apiUrl = spec.api(token)
  if (!apiUrl) return { ok: false, postings: [], error: `${spec.label} 的 token 格式不对（${spec.hint}）` }

  const headers = { 'user-agent': ua ?? 'Mozilla/5.0 (compatible; CareerOS/0.1)', accept: 'application/json' }
  try {
    // Workday exposes a POST search endpoint; everything else is a plain GET.
    const init = spec.needsPost
      ? {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 100, offset: 0, searchText: query }),
      }
      : { headers }
    const res = await fetch(apiUrl, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, status: res.status, apiUrl, postings: [], error: `HTTP ${res.status}：${text.slice(0, 200)}` }
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, status: res.status, apiUrl, postings: [], error: '返回的不是 JSON（可能被反爬或需要登录）' }
    }
    const postings = normalizeAtsPayload(ats, json)
    return {
      ok: postings.length > 0,
      status: res.status,
      apiUrl,
      ats,
      token,
      postings,
      total: postings.length,
      error: postings.length ? undefined : '接口返回了 JSON，但没有识别到岗位字段（结构可能变了）',
      fingerprint: sha1ish(`${apiUrl}|${postings.length}|${postings.map((p) => p.url ?? p.title).join(',')}`),
    }
  } catch (err) {
    return { ok: false, postings: [], apiUrl, error: String(err?.message ?? err) }
  }
}

export function guessRecruitType(text) {
  const t = String(text ?? '')
  if (/intern|实习/i.test(t)) return 'daily'
  return null
}

export { parseDeadline }
