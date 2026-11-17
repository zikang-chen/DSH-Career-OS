// 运行时自检与依赖安装：让「换台机器也能跑」变成可验证的事实，而不是口头承诺。
//
// 三件事：
//   1. 探测 PDF 解析依赖（runtime/pylib）、LaTeX 引擎、Python 解释器；
//   2. 缺依赖时一条命令装进项目内目录（pip --target），不碰用户的全局 Python；
//   3. 汇总 DSH 侧的 web 搜索/抓取提供方状态，暴露真实的提供方 id。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { detectEngines } from './latex.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(HERE, '..')
export const PYLIB_DIR = path.join(PACKAGE_ROOT, 'runtime', 'pylib')

/** Which Python packages the resume extractor needs, and why. */
export const PDF_PACKAGES = ['pdfminer.six', 'pypdf']

export function pylibPresent() {
  try {
    return fs.existsSync(path.join(PYLIB_DIR, 'pdfminer')) || fs.existsSync(path.join(PYLIB_DIR, 'pypdf'))
  } catch {
    return false
  }
}

function run(command, args, { timeoutMs = 240_000, cwd = PACKAGE_ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
      }),
    )
  })
}

export async function probePython(pythonPath = 'python') {
  const result = await run(pythonPath, ['-c', 'import sys;print(sys.version.split()[0]);print(sys.executable)'], { timeoutMs: 20_000 })
  if (!result.ok) return { ok: false, python: pythonPath, error: (result.stderr || result.stdout).slice(-300) }
  const [version, executable] = result.stdout.split(/\r?\n/)
  return { ok: true, python: pythonPath, version, executable }
}

/** Are the PDF libs importable *through the extractor's own sys.path*? */
export async function probePdfLibs(pythonPath = 'python') {
  const script = [
    'import sys,os,json',
    `sys.path.insert(0, ${JSON.stringify(PYLIB_DIR)})`,
    'out={}',
    'for m in ("pdfminer","pypdf"):',
    '    try:',
    '        __import__(m); out[m]=True',
    '    except Exception as e:',
    '        out[m]=False',
    'print(json.dumps(out))',
  ].join('\n')
  const result = await run(pythonPath, ['-c', script], { timeoutMs: 30_000 })
  if (!result.ok) return { ok: false, error: (result.stderr || result.stdout).slice(-300) }
  try {
    const parsed = JSON.parse(result.stdout)
    return { ok: Boolean(parsed.pdfminer || parsed.pypdf), pdfminer: parsed.pdfminer, pypdf: parsed.pypdf }
  } catch {
    return { ok: false, error: '探测输出无法解析' }
  }
}

/**
 * Install the PDF libraries into `runtime/pylib` (project-local, isolated).
 * Never installs into the user's global environment.
 */
export async function installPdfLibs(pythonPath = 'python') {
  fs.mkdirSync(PYLIB_DIR, { recursive: true })
  const result = await run(pythonPath, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
    '--target', PYLIB_DIR, ...PDF_PACKAGES,
  ])
  return {
    ok: result.ok,
    target: PYLIB_DIR,
    output: (result.stdout || result.stderr).slice(-1500),
  }
}

/** Everything the panel / doctor needs in one object. */
export async function runtimeHealth({ config, db, clientHealth, webService } = {}) {
  const pythonPath = config?.pythonPath ?? 'python'
  const [python, pdf] = await Promise.all([probePython(pythonPath), probePdfLibs(pythonPath)])
  let web = null
  try {
    if (webService?.listProviders) {
      const providers = webService.listProviders()
      web = {
        search: (providers?.search ?? []).map((p) => p.id),
        fetch: (providers?.fetch ?? []).map((p) => p.id),
      }
    } else {
      web = { available: false, reason: 'web service 未注册' }
    }
  } catch (err) {
    web = { error: String(err?.message ?? err) }
  }
  const engines = detectEngines()
  const clientInfo = typeof clientHealth === 'function' ? clientHealth() : null
  const dbInfo = db?.info ? db.info() : null
  return {
    ok: Boolean(python?.ok),
    node: process.version,
    electron: process.versions?.electron ?? null,
    packageRoot: PACKAGE_ROOT,
    python,
    pdfLibs: { ...pdf, dir: PYLIB_DIR, installed: pylibPresent() },
    latex: { engines: engines.map((e) => e.engine), found: engines.length > 0 },
    web,
    database: dbInfo,
    client: clientInfo,
    checks: [
      { key: 'python', label: 'Python 解释器', done: Boolean(python?.ok), detail: python?.executable ?? python?.error ?? '' },
      { key: 'pdf', label: 'PDF 解析依赖（项目内隔离）', done: Boolean(pdf?.ok), detail: pdf?.ok ? PYLIB_DIR : '未安装：可用 career_runtime_setup 一键装' },
      { key: 'latex', label: 'LaTeX 引擎（简历 PDF 编译）', done: engines.length > 0, detail: engines.map((e) => e.engine).join(', ') || '未检测到 xelatex/lualatex/pdflatex' },
      { key: 'web-search', label: 'Web 搜索提供方', done: (web?.search ?? []).length > 0, detail: (web?.search ?? []).join(', ') || (web?.reason ?? '无') },
      { key: 'web-fetch', label: 'Web 抓取提供方（应恰好一个）', done: (web?.fetch ?? []).length === 1, detail: (web?.fetch ?? []).join(', ') || '无' },
      { key: 'db', label: 'SQLite 数据库', done: Boolean(dbInfo?.file), detail: dbInfo?.file ?? '' },
      { key: 'client', label: '浏览器半进入 boot graph', done: Boolean(clientInfo?.inGraph), detail: clientInfo?.rev ?? '' },
    ],
  }
}
