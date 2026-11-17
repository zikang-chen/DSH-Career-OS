// 一键把 PDF 解析依赖装到项目内的 runtime/pylib（不碰用户全局 Python）。
// 用法：node scripts/setup-runtime.mjs [--python <exe>]
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(ROOT, 'runtime', 'pylib')
const PKGS = ['pdfminer.six', 'pypdf']

const pythonArg = process.argv.indexOf('--python')
const python = pythonArg > -1 ? process.argv[pythonArg + 1] : 'python'

function run(command, args, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err?.message }))
  })
}

async function main() {
  console.log(`[setup] python   = ${python}`)
  console.log(`[setup] target   = ${TARGET}`)
  const version = await run(python, ['-c', 'import sys;print(sys.version.split()[0])'], 20_000)
  if (!version.ok) {
    console.error(`[setup] 找不到可用的 Python：${version.error ?? version.stderr}`)
    process.exit(1)
  }
  console.log(`[setup] version  = ${version.stdout.trim()}`)

  fs.mkdirSync(TARGET, { recursive: true })
  console.log(`[setup] installing ${PKGS.join(', ')} ...`)
  const install = await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--target', TARGET, ...PKGS])
  const tail = (install.stdout || install.stderr).trim().split(/\r?\n/).slice(-6).join('\n')
  console.log(tail)
  if (!install.ok) {
    console.error('[setup] 安装失败。可尝试：换镜像源 `-i https://pypi.tuna.tsinghua.edu.cn/simple`')
    process.exit(1)
  }

  const verify = await run(python, ['-c', [
    'import sys,json',
    `sys.path.insert(0, ${JSON.stringify(TARGET)})`,
    'r={}',
    'for m in ("pdfminer","pypdf"):',
    '    try:',
    '        __import__(m); r[m]=True',
    '    except Exception:',
    '        r[m]=False',
    'print(json.dumps(r))',
  ].join('\n')], 30_000)
  console.log(`[setup] verify   = ${verify.stdout.trim() || verify.stderr.trim()}`)
  console.log('[setup] done. 重新导入 PDF 简历即可。')
}

await main()
