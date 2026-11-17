// Small shared helpers. Deliberately dependency-free: this plugin imports nothing
// outside `node:` builtins so it installs without any package resolution step.
import { randomUUID } from 'node:crypto'

export const nowIso = () => new Date().toISOString()

export const uuid = () => randomUUID()

/** `YYYY-MM-DD` in local time — the granularity the whole app uses for days. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function daysBetween(fromIso, toIso = today()) {
  if (!fromIso) return null
  const a = Date.parse(fromIso.length === 10 ? `${fromIso}T00:00:00Z` : fromIso)
  const b = Date.parse(toIso.length === 10 ? `${toIso}T00:00:00Z` : toIso)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/**
 * node:sqlite binds only null/number/bigint/string/Uint8Array. Everything else
 * (booleans, objects, arrays, Dates, undefined) is normalized here so callers
 * never have to think about it.
 */
export function bind(value) {
  if (value === undefined || value === null) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
      return value
    case 'boolean':
      return value ? 1 : 0
    case 'object':
      if (value instanceof Uint8Array) return value
      if (value instanceof Date) return value.toISOString()
      return JSON.stringify(value)
    default:
      return String(value)
  }
}

export function bindAll(params) {
  return Array.isArray(params) ? params.map(bind) : []
}

/** JSON column → value, tolerating NULL and pre-existing garbage. */
export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  if (typeof text !== 'string') return text
  try {
    const v = JSON.parse(text)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

export const toBool = (v) => v === 1 || v === true || v === '1' || v === 'true'

export function str(v, max = 4000) {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\r\n/g, '\n').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function arr(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && String(x).trim() !== '').map((x) => String(x).trim())
  if (typeof v === 'string' && v.trim()) return v.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * Normalize text for identity comparison: full-width → half-width, lowercase,
 * strip punctuation/whitespace, drop common legal suffixes.
 */
export function normKey(input) {
  if (!input) return ''
  let s = String(input).normalize('NFKC').toLowerCase()
  s = s.replace(/[\s\u3000]+/g, '')
  s = s.replace(/[（）()【】\[\]「」『』<>《》,，.。;；:：!！?？'"“”‘’/\\|_\-—–~·、]/g, '')
  return s
}

const COMPANY_SUFFIXES = [
  '股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '控股',
  'co.,ltd', 'co.ltd', 'coltd', 'ltd', 'inc', 'corp', 'corporation', 'company', 'gmbh', 'llc',
]

/**
 * Geographic / corporate noise that appears inside Chinese legal names but carries no
 * employer identity: `北京字节跳动科技有限公司` and `字节跳动` are one employer.
 * Deliberately conservative — a real brand token here (音乐, 银行, 云 …) would merge
 * genuinely different companies, so it is not in this list.
 */
const COMPANY_NOISE = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津', '重庆',
  '香港', '新加坡', '中国',
  '信息技术', '科技', '技术', '信息', '网络', '软件', '系统', '数字', '智能',
  '传媒', '文化', '控股', '股份', '集团', '投资', '咨询', '服务', '发展',
  '电子商务', '电子', '商贸', '实业',
]

/**
 * Company identity key: strips legal suffixes and geographic/corporate noise so that
 * legal-name variants of one employer collapse to the same key.
 */
export function companyKey(name) {
  let s = normKey(name)
  if (!s) return ''
  for (const suffix of COMPANY_SUFFIXES) {
    const suf = normKey(suffix)
    if (suf && s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length)
      break
    }
  }
  for (const noise of COMPANY_NOISE) {
    const n = normKey(noise)
    if (!n || s.length <= n.length) continue
    if (s.includes(n)) s = s.split(n).join('')
  }
  return s || normKey(name)
}

/**
 * Title identity key. Also removes recruitment-noise words so `2026暑期实习-产品经理`
 * and `产品经理（暑期实习）` converge, while keeping seniority/level tokens.
 */
export function titleKey(title) {
  let s = normKey(title)
  if (!s) return ''
  s = s
    .replace(/(急招|热招|诚聘|招聘|内推|长期有效|急聘)/g, '')
    .replace(/(20\d{2}|19\d{2})/g, '')
    .replace(/(暑期实习|寒假实习|日常实习|长期实习|短期实习|实习生|实习)/g, '')
  return s || normKey(title)
}

export function sha1ish(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) * 0x01000193 >>> 0
    h2 = (h2 + c * 31) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Text similarity 0..1 (token-set Jaccard + character-bigram fallback). */
export function similarity(a, b) {
  const na = normKey(a)
  const nb = normKey(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    if (s.length === 1) set.add(s)
    return set
  }
  const ga = grams(na)
  const gb = grams(nb)
  let shared = 0
  for (const g of ga) if (gb.has(g)) shared += 1
  return (2 * shared) / (ga.size + gb.size || 1)
}

export function redact(text, max = 200) {
  if (text === null || text === undefined) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
