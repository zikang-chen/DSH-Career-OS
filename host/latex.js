// LaTeX 简历：源码生成 + 本地编译（Overleaf 式的「左边源码、右边 PDF」）。
//
// Compilation runs the local XeLaTeX engine with `-no-shell-escape`, inside a private
// work directory, with a hard timeout. Nothing is compiled from user input without
// those three guards.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sha1ish } from './util.js'

export const ENGINE_CANDIDATES = ['xelatex', 'lualatex', 'pdflatex']

/** Escape text so a Chinese/English bullet cannot break the document. */
export function escapeTex(input) {
  return String(input ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

const PREAMBLE = `\\documentclass[10.5pt]{ctexart}
\\usepackage[margin=1.5cm]{geometry}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{xcolor}
\\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}
\\pagestyle{empty}
\\definecolor{accent}{RGB}{37,99,235}
\\newcommand{\\cvsection}[1]{\\vspace{6pt}{\\color{accent}\\bfseries\\large #1}\\par\\vspace{-4pt}\\hrule\\vspace{4pt}}
\\newcommand{\\cvrow}[3]{\\textbf{#1}\\hfill #2\\hfill\\textit{#3}\\par}
`

/**
 * Render a structured resume into .tex.
 * @param {object} input
 * @param {object} input.profile
 * @param {Array<{label:string, items:Array}>} input.sections
 * @param {string} [input.title]
 */
export function renderResumeTex({ profile = {}, sections = [], title } = {}) {
  const name = escapeTex(profile.display_name || title || '简历')
  const contact = [profile.phone_masked, profile.email].filter(Boolean).map(escapeTex).join(' \\quad ')
  const headline = profile.headline ? `\\begin{center}\\small ${escapeTex(profile.headline)}\\end{center}` : ''
  const body = []

  body.push('\\begin{center}')
  body.push(`{\\LARGE\\bfseries ${name}}`)
  body.push('\\end{center}')
  if (contact) body.push(`\\begin{center}\\small ${contact}\\end{center}`)
  if (headline) body.push(headline)

  for (const section of sections) {
    if (!section.items?.length) continue
    body.push(`\\cvsection{${escapeTex(section.label)}}`)
    for (const item of section.items) {
      if (item.role || item.period) {
        const left = [item.org, item.location].filter(Boolean).map(escapeTex).join(' \\,')
        body.push(`\\cvrow{${left || ' '}}{${escapeTex(item.period ?? '')}}{${escapeTex(item.role ?? '')}}`)
      } else if (item.org) {
        // 只有机构名（如「专利与语言成绩」这类分组标题）：单独一行，不排空的三列。
        body.push(`{\\bfseries ${escapeTex(item.org)}}\\par`)
      }
      const bullets = (item.bullets ?? []).filter(Boolean)
      if (bullets.length) {
        body.push('\\begin{itemize}')
        for (const bullet of bullets) body.push(`  \\item ${escapeTex(bullet)}`)
        body.push('\\end{itemize}')
      }
    }
  }

  return `${PREAMBLE}\\begin{document}\n${body.join('\n')}\n\\end{document}\n`
}

/** Plain-text projection of the same structured resume (used for matching/diff). */
export function renderResumeText({ profile = {}, sections = [] } = {}) {
  const lines = []
  if (profile.display_name) lines.push(profile.display_name)
  if (profile.headline) lines.push(profile.headline)
  lines.push('')
  for (const section of sections) {
    if (!section.items?.length) continue
    lines.push(section.label)
    for (const item of section.items) {
      const head = [item.org, item.role, item.period, item.location].filter(Boolean).join(' · ')
      if (head) lines.push(head)
      for (const bullet of item.bullets ?? []) lines.push(`- ${bullet}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function runEngine(engine, texPath, workDir, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      engine,
      ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-file-line-error', path.basename(texPath)],
      { cwd: workDir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * Compile a .tex string to PDF.
 * @returns {Promise<{ok:boolean, pdfPath?:string, log:string, engine?:string, ms:number, cached?:boolean, error?:string}>}
 */
export async function compileTex(tex, { dataDir, timeoutMs = 60_000, preferEngine } = {}) {
  const started = Date.now()
  const hash = sha1ish(tex)
  const root = path.join(dataDir ?? '.', 'tex')
  const workDir = path.join(root, hash)
  const pdfPath = path.join(workDir, 'resume.pdf')
  fs.mkdirSync(workDir, { recursive: true })

  if (fs.existsSync(pdfPath)) {
    return { ok: true, pdfPath, cached: true, log: '复用已编译结果', ms: 0, engine: 'cache', hash }
  }

  const texPath = path.join(workDir, 'resume.tex')
  fs.writeFileSync(texPath, tex, 'utf8')

  const engines = preferEngine ? [preferEngine, ...ENGINE_CANDIDATES] : ENGINE_CANDIDATES
  let lastLog = ''
  let lastError = null
  for (const engine of engines) {
    // xelatex needs two passes for hyperref refs; a second pass also settles fonts.
    for (let pass = 0; pass < 2; pass += 1) {
      const { err, stdout, stderr } = await runEngine(engine, texPath, workDir, timeoutMs)
      lastLog = `${stdout}\n${stderr}`.trim()
      if (err) {
        lastError = err.killed ? `编译超时（${timeoutMs}ms）` : `${engine} 失败：${err.message}`
        // A missing engine is worth trying the next candidate; a real TeX error is not.
        if (/ENOENT|not recognized|不是内部或外部命令/i.test(String(err.message))) break
        return { ok: false, log: lastLog.slice(-4000), error: lastError, ms: Date.now() - started, engine, hash }
      }
      if (pass === 0 && !fs.existsSync(pdfPath)) {
        // Some engines need the second pass to emit the PDF at all.
        continue
      }
    }
    if (fs.existsSync(pdfPath)) {
      return { ok: true, pdfPath, log: lastLog.slice(-4000), ms: Date.now() - started, engine, hash }
    }
    lastError = lastError ?? `${engine} 未生成 PDF`
  }
  return { ok: false, log: lastLog.slice(-4000), error: lastError ?? '没有可用的 LaTeX 引擎（尝试过 xelatex/lualatex/pdflatex）', ms: Date.now() - started, hash }
}

/** Which engines exist on this machine (used by the settings panel). */
export function detectEngines() {
  const found = []
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const engine of ENGINE_CANDIDATES) {
    const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : ['']
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, `${engine}${ext}`)
        try {
          if (dir && fs.existsSync(candidate)) {
            found.push({ engine, path: candidate })
            break
          }
        } catch {
          /* unreadable PATH entry */
        }
      }
      if (found.some((f) => f.engine === engine)) break
    }
  }
  return found
}
