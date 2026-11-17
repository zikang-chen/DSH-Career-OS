// Resume ingestion: raw file → text → a *proposed* structured profile.
// Nothing here writes to the user profile. A proposal is always marked
// `requiresConfirmation` so an extraction guess can never masquerade as fact.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { arr } from './util.js'
import { SKILL_LEXICON, extractSkills } from './domain.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTRACTOR = path.resolve(HERE, '..', 'scripts', 'extract_resume.py')

export const SUPPORTED_EXTENSIONS = ['.md', '.txt', '.json', '.docx', '.pdf']

export function detectFormat(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase()
  if (!ext) return null
  return SUPPORTED_EXTENSIONS.includes(ext) ? ext.slice(1) : null
}

function runPython(pythonPath, args, timeoutMs) {
  return new Promise((resolve) => {
    // Force UTF-8 for the child's stdio: on Chinese Windows a piped stdout defaults to
    // GBK, which cannot encode bullets like "•" and would crash the extractor.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    execFile(pythonPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      const errText = String(stderr ?? '').trim()
      if (err && !stdout) {
        const timedOut = err.killed || err.signal === 'SIGTERM' || /timed? ?out/i.test(String(err.message))
        resolve({
          ok: false,
          error: timedOut
            ? `解析超时（${Math.round(timeoutMs / 1000)}s）：这份 PDF 可能结构异常或过大。可以改用「粘贴简历文本」导入。`
            : `${err.message}${errText ? ` | ${errText.slice(-600)}` : ''}`,
        })
        return
      }
      if (errText && !stdout) {
        resolve({ ok: false, error: errText.slice(-600) })
        return
      }
      try {
        const parsed = JSON.parse(String(stdout))
        if (errText && parsed && !parsed.notes) parsed.notes = []
        resolve(parsed)
      } catch {
        resolve({ ok: false, error: `提取脚本输出无法解析：${String(stdout).slice(0, 200)}${errText ? ` | ${errText.slice(-300)}` : ''}` })
      }
    })
  })
}

/**
 * Which interpreter to use. PDF libraries are installed into `runtime/pylib` inside
 * this package (pip --target) and the extractor prepends it to sys.path, so the plain
 * `python` on PATH works; an explicit `pythonPath` config wins.
 */
function pythonCandidates(configured) {
  return [configured, process.env.DSH_PYTHON, 'python', 'py', 'python3']
    .filter((value, index, all) => value && all.indexOf(value) === index)
}

/**
 * Read resume text from a file on disk.
 * @returns {Promise<{ok:boolean,text?:string,format?:string,engine?:string,notes:string[],error?:string}>}
 */
export async function extractResumeText(filePath, { pythonPath = 'python', timeoutMs = 60_000 } = {}) {
  const notes = []
  if (!filePath) return { ok: false, notes, error: '缺少文件路径' }
  if (!fs.existsSync(filePath)) return { ok: false, notes, error: `文件不存在：${filePath}` }
  const format = detectFormat(filePath)
  if (!format) {
    return {
      ok: false,
      notes,
      error: `不支持的格式 ${path.extname(filePath)}。支持 ${SUPPORTED_EXTENSIONS.join(' / ')}；.doc 旧格式请先另存为 .docx。`,
    }
  }
  if (format === 'md' || format === 'txt') {
    const text = fs.readFileSync(filePath, 'utf8')
    return { ok: true, text, format, notes: ['纯文本直接读取'] }
  }
  if (format === 'json') {
    const text = fs.readFileSync(filePath, 'utf8')
    return { ok: true, text, format, notes: ['JSON 结构直接读取'] }
  }
  const candidates = pythonCandidates(pythonPath)
  let lastError = null
  for (const candidate of candidates) {
    const res = await runPython(candidate, [EXTRACTOR, filePath, format], timeoutMs)
    if (res.ok === false && res.error && /ENOENT|不是内部或外部命令|not found/i.test(res.error)) {
      lastError = res.error
      continue
    }
    if (res.error) {
      return { ok: false, notes: [...(res.notes ?? []), ...notes], error: res.error, meta: res }
    }
    return {
      ok: Boolean(res.ok),
      text: res.text ?? '',
      format,
      engine: res.engine ?? null,
      attempts: res.attempts ?? [],
      notes: [...(res.notes ?? []), ...notes],
      meta: res,
    }
  }
  return {
    ok: false,
    notes,
    error: `找不到可用的 Python 解释器（尝试过 ${candidates.join(', ')}）。可手动粘贴简历文本，或在插件配置里指定 pythonPath。${lastError ? ` 最后错误：${lastError}` : ''}`,
  }
}

// ─── heuristic structured extraction ─────────────────────────────────────────
const SECTION_PATTERNS = [
  { key: 'education', re: /^(教育背景|教育经历|学历|education)/i },
  { key: 'experience', re: /^(实习经历|工作经历|实习|工作经验|experience|employment)/i },
  { key: 'projects', re: /^(项目经历|项目经验|projects?)/i },
  { key: 'research', re: /^(科研经历|研究经历|research)/i },
  { key: 'skills', re: /^(技能|专业技能|技能特长|skills?)/i },
  { key: 'awards', re: /^(奖项|获奖|荣誉|证书|awards?|honors?|certificates?)/i },
  { key: 'languages', re: /^(语言|语言能力|languages?)/i },
  { key: 'summary', re: /^(个人简介|自我介绍|自我评价|summary|profile|about)/i },
]

const DEGREE_RE = /(博士|硕士|本科|学士|大专|PhD|Ph\.D|Master|Bachelor|MSc|BSc)/i
const SCHOOL_RE = /([\u4e00-\u9fff]{2,20}(?:大学|学院|研究院|University|College|Institute))/i
const MAJOR_RE = /(专业[:：]\s*([^\n|｜]{2,30}))|([\u4e00-\u9fff]{2,12}(?:专业|系))/i
const YEAR_RE = /(20\d{2})/
const DATE_RANGE_RE = /((20\d{2})[.\-/年]?(\d{1,2})?月?\s*[-–—~至到]\s*(至今|(20\d{2})[.\-/年]?(\d{1,2})?))/g
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/
const PHONE_RE = /(1[3-9]\d{9})/

/**
 * Split into labeled sections. Headings are short lines matching the vocabulary
 * above; anything before the first heading is the header block.
 */
export function splitSections(text) {
  const lines = String(text ?? '').split('\n')
  const sections = { header: [] }
  let current = 'header'
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const compact = line.replace(/[【】\[\]】:：\s]/g, '')
    const hit = line.length <= 24 ? SECTION_PATTERNS.find((p) => p.re.test(compact)) : null
    if (hit) {
      current = hit.key
      sections[current] ??= []
      continue
    }
    sections[current] ??= []
    sections[current].push(line)
  }
  return sections
}

function maskPhone(phone) {
  if (!phone) return null
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

function linesToEntries(lines) {
  const entries = []
  let buffer = []
  const isBullet = (line) => /^[-•·*\u25cf\u25aa]/.test(line)
  const startsEntry = (line) => /^(20\d{2}|[0-9]{4}[.\-/])/.test(line) || /\|/.test(line)
  const flush = () => {
    if (buffer.length) entries.push(buffer.join('\n'))
    buffer = []
  }
  for (const line of lines) {
    if (isBullet(line)) {
      // A bullet always belongs to the entry above it.
      buffer.push(line)
      continue
    }
    if (startsEntry(line)) {
      flush()
      buffer.push(line)
      continue
    }
    // A plain line after we already collected bullets means a new entry started.
    if (buffer.some(isBullet)) {
      flush()
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  flush()
  return entries.map((e) => e.trim()).filter(Boolean)
}

/** Strip school/degree/date noise out of an education line and keep the major. */
function extractMajor(line, school, degree) {
  if (!line) return null
  let s = line
  if (school) s = s.split(school).join(' ')
  if (degree) s = s.split(degree).join(' ')
  s = s
    .replace(/20\d{2}\s*[.\-/年]?\s*\d{0,2}\s*月?\s*[-–—~至到]\s*(至今|20\d{2}\s*[.\-/年]?\s*\d{0,2}\s*月?)?/g, ' ')
    .replace(/\b20\d{2}\s*年?\b/g, ' ')
    .replace(/[|｜,，:：]/g, ' ')
  const m = /([\u4e00-\u9fff]{2,12}(?:专业|系|科学|工程|技术|管理|经济|金融|统计|数学|传播|设计|法律|医学)[\u4e00-\u9fff]{0,8})/.exec(s)
  return m ? m[1].trim() : null
}

function parseEntryDate(entry) {
  const matches = [...entry.matchAll(DATE_RANGE_RE)]
  if (!matches.length) return { start: null, end: null }
  const m = matches[matches.length - 1]
  const start = m[2] ? `${m[2]}${m[3] ? `-${String(m[3]).padStart(2, '0')}` : ''}` : null
  const end = m[4] === '至今' ? '至今' : m[5] ? `${m[5]}${m[6] ? `-${String(m[6]).padStart(2, '0')}` : ''}` : null
  return { start, end }
}

/**
 * Build a proposed profile from resume text. Every field is a *candidate* until the
 * user confirms it; `confidence` reflects how much of the text was parsed.
 */
export function parseResume(text, { fileName } = {}) {
  const source = String(text ?? '')
  const sections = splitSections(source)
  const joined = (k) => (sections[k] ?? []).join('\n')
  const header = joined('header')

  const email = EMAIL_RE.exec(source)?.[0] ?? null
  const phoneRaw = PHONE_RE.exec(source)?.[0] ?? null

  const eduText = `${header}\n${joined('education')}`
  const eduLine = (sections.education ?? []).find((line) => SCHOOL_RE.test(line)) ?? header
  const school = SCHOOL_RE.exec(eduText)?.[1] ?? null
  const degree = DEGREE_RE.exec(eduText)?.[1] ?? null
  const majorMatch = MAJOR_RE.exec(eduText)
  const major = (majorMatch ? (majorMatch[2] ?? majorMatch[3] ?? null) : null) ?? extractMajor(eduLine, school, degree)
  const gradYearMatch = /(20\d{2})\s*(?:年)?\s*(?:毕业|届)/.exec(source) ?? YEAR_RE.exec(eduText)
  const gradYear = gradYearMatch ? Number(gradYearMatch[1]) : null

  const nameLine = (sections.header ?? []).find((l) => /^[\u4e00-\u9fff]{2,4}$/.test(l) || /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,2}$/.test(l))
  const headlineLine = (sections.header ?? []).find((l) => /实习|求职|方向|岗位|工程师|分析师|产品/.test(l) && l !== nameLine)

  const experience = linesToEntries(sections.experience ?? []).map((entry) => {
    const { start, end } = parseEntryDate(entry)
    const firstLine = entry.split('\n')[0]
    const org = /[\u4e00-\u9fff]{2,20}(?:公司|集团|银行|证券|基金|科技|研究院|事业部)/.exec(entry)?.[0] ?? null
    const titleLine = entry.split('\n').find((l) => /实习|工程师|分析师|产品|运营|研究员|助理/.test(l)) ?? null
    return {
      raw: entry.slice(0, 600),
      organization: org,
      role: titleLine ? titleLine.replace(/[|｜]/g, ' ').trim().slice(0, 80) : firstLine.slice(0, 80),
      start,
      end,
      bullets: entry.split('\n').filter((l) => /^[-•·*\u25cf]/.test(l)).slice(0, 8),
    }
  })

  const projects = linesToEntries(sections.projects ?? []).map((entry) => ({
    raw: entry.slice(0, 600),
    name: entry.split('\n')[0].slice(0, 120),
    bullets: entry.split('\n').filter((l) => /^[-•·*\u25cf]/.test(l)).slice(0, 8),
  }))

  const skillsText = `${joined('skills')}\n${source}`
  const skills = extractSkills(skillsText, SKILL_LEXICON)

  const languages = ['CET-4', 'CET-6', 'IELTS', 'TOEFL', 'GRE', '日语', '英语', '普通话']
    .filter((l) => source.toUpperCase().includes(l.toUpperCase()))

  const certificates = (sections.awards ?? []).filter((l) => /证书|奖|奖学|竞赛|CPA|CFA|资格/.test(l)).slice(0, 15)

  const extractedChars = Object.values(sections).flat().join('').length
  const confidence = Math.max(0, Math.min(1, source.length ? extractedChars / Math.max(source.length, 1) : 0))

  const notes = []
  if (!school) notes.push('未识别到学校名称，请手动确认')
  if (!gradYear) notes.push('未识别到毕业年份，请手动确认')
  if (!experience.length) notes.push('未识别到实习经历段落，若确有实习请手动补充')
  if (confidence < 0.5) notes.push('分段识别率偏低：建议检查分节标题（教育背景/实习经历/项目经历/技能）')

  return {
    requiresConfirmation: true,
    fileName: fileName ?? null,
    contact: { email, phoneMasked: maskPhone(phoneRaw) },
    identity: {
      displayName: nameLine ?? null,
      headline: headlineLine ?? null,
    },
    education: [{ school, degree, major, gradYear }].filter((e) => e.school || e.degree),
    experience,
    projects,
    research: linesToEntries(sections.research ?? []).map((e) => ({ raw: e.slice(0, 600), name: e.split('\n')[0].slice(0, 120) })),
    skills,
    languages,
    certificates,
    sectionKeys: Object.keys(sections),
    confidence: Number(confidence.toFixed(3)),
    notes,
    caveat: '以上全部为解析候选，未经你确认不得视为事实；系统不会自行编造经历、学历或量化指标。',
  }
}

/** Flatten a proposal into a `career_profile_update`-shaped patch suggestion. */
export function proposalToProfilePatch(proposal) {
  if (!proposal) return {}
  const edu = proposal.education?.[0] ?? {}
  return {
    displayName: proposal.identity?.displayName ?? null,
    headline: proposal.identity?.headline ?? null,
    school: edu.school ?? null,
    degree: edu.degree ?? null,
    major: edu.major ?? null,
    gradYear: edu.gradYear ?? null,
    skills: arr(proposal.skills).map((s) => ({ name: s, verified: false })),
  }
}
