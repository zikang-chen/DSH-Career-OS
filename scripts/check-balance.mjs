// Report the first line where bracket depth goes negative, plus the deepest
// unbalanced openings, while skipping strings/template-literals/comments.
import fs from 'node:fs'

const file = process.argv[2]
const src = fs.readFileSync(file, 'utf8')

let depth = 0
let line = 1
let i = 0
const stack = [] // { ch, line }
const problems = []

function push(ch, ln) { stack.push({ ch, line: ln }); depth += 1 }
function pop(ch, ln) {
  const opener = stack.pop()
  if (!opener) { problems.push(`L${ln}: unexpected '${ch}' (nothing open)`); return }
  const pairs = { ')': '(', ']': '[', '}': '{' }
  if (opener.ch !== pairs[ch]) problems.push(`L${ln}: '${ch}' closes '${opener.ch}' opened at L${opener.line}`)
  depth -= 1
  if (depth < 0) { problems.push(`L${ln}: depth went negative`); depth = 0 }
}

while (i < src.length) {
  const ch = src[i]
  if (ch === '\n') { line += 1; i += 1; continue }
  if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
  if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1 } i += 2; continue }
  if (ch === "'" || ch === '"') {
    const quote = ch
    i += 1
    while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i += 1; if (src[i] === '\n') line += 1; i += 1 }
    i += 1
    continue
  }
  if (ch === '`') {
    i += 1
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 1; continue }
      if (src[i] === '\n') line += 1
      if (src[i] === '$' && src[i + 1] === '{') {
        // template expression: track braces
        push('{', line)
        let braces = 1
        i += 2
        while (i < src.length && braces > 0) {
          if (src[i] === '\n') line += 1
          if (src[i] === '{') braces += 1
          else if (src[i] === '}') braces -= 1
          else if (src[i] === '`') {
            // nested template — skip crudely
            i += 1
            while (i < src.length && src[i] !== '`') { if (src[i] === '\\') i += 1; if (src[i] === '\n') line += 1; i += 1 }
          }
          i += 1
        }
        pop('}', line)
        continue
      }
      i += 1
    }
    i += 1
    continue
  }
  if (ch === '(' || ch === '[' || ch === '{') push(ch, line)
  else if (ch === ')' || ch === ']' || ch === '}') pop(ch, line)
  i += 1
}

console.log(`final depth=${depth}`)
console.log('first problems:', problems.slice(0, 8))
console.log('still open (last 12):', stack.slice(-12).map((s) => `${s.ch}@L${s.line}`).join(' '))
