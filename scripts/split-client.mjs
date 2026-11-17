// 一次性脚本：把 client/index.cjs 按顶层分节注释切成 client/parts/*.cjs。
// 安全性：切分后立刻拼回，并断言与原文件**字节完全相同**，否则中止。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'client', 'index.cjs')
const PARTS = path.join(ROOT, 'client', 'parts')

const text = fs.readFileSync(SRC, 'utf8')
// 在每个顶层分节注释前切开（保留注释本身在下一段开头）
const chunks = text.split(/\n(?=\/\/ ─── )/)

function slugOf(chunk, index) {
  const m = /^\/\/ ─── (.+?) ─{3,}/.exec(chunk)
  if (!m) return `${String(index).padStart(2, '0')}-header`
  const slug = m[1].trim().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
  return `${String(index).padStart(2, '0')}-${slug}`
}

const joined = chunks.join('\n')
if (joined !== text) {
  console.error('[split] 拼回不一致，已中止（未写入任何文件）')
  process.exit(1)
}

fs.rmSync(PARTS, { recursive: true, force: true })
fs.mkdirSync(PARTS, { recursive: true })
const written = []
chunks.forEach((chunk, i) => {
  const name = `${slugOf(chunk, i)}.cjs`
  // 每个 part 之间用单个换行分隔，拼回时与原文一致
  fs.writeFileSync(path.join(PARTS, name), chunk, 'utf8')
  written.push({ name, lines: chunk.split('\n').length })
})

// 校验：从 parts 读回、按名排序拼接，必须与原文一致
const rebuild = fs.readdirSync(PARTS).filter((n) => n.endsWith('.cjs')).sort()
  .map((n) => fs.readFileSync(path.join(PARTS, n), 'utf8')).join('\n')
if (rebuild !== text) {
  console.error('[split] 从 parts 重建不一致，已中止')
  process.exit(1)
}

console.log(`[split] ${chunks.length} parts, byte-identical OK`)
for (const w of written) console.log(`  ${w.name}  (${w.lines} 行)`)
