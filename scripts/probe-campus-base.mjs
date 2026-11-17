// 第二轮：拿第一轮发现的叶子路径，配上可能的 API 前缀与 POST 体，找出真正能返回岗位的地址。
// 只发少量请求（≤14），每次间隔 1s，只读公开接口。
import { setTimeout as sleep } from 'node:timers/promises'

const ORIGIN = 'https://jobs.bytedance.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PREFIXES = ['/api/v1', '/api/v2', '']
const PATHS = ['/search/job/posts', '/job/posts/']
const BODY = JSON.stringify({ keyword: '', limit: 10, offset: 0, job_category_id_list: [], city_code_list: [], portal_type: 6 })

async function call(url, method, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        ...(body ? { 'content-type': 'application/json' } : {}),
        referer: `${ORIGIN}/campus`,
        env: 'undefined',
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    return { status: response.status, type: response.headers.get('content-type') ?? '', bytes: buffer.length, text: buffer.subarray(0, 4000).toString('utf8') }
  } catch (err) {
    return { status: 0, type: '', bytes: 0, text: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

function shape(text) {
  try {
    const json = JSON.parse(text)
    const walk = (node, depth = 0) => {
      if (Array.isArray(node)) return `数组(${node.length})${node.length ? ` 首项 ${walk(node[0], depth + 1)}` : ''}`
      if (node && typeof node === 'object') {
        if (depth >= 2) return '{…}'
        return `{${Object.keys(node).slice(0, 8).join(', ')}}`
      }
      return typeof node
    }
    return walk(json)
  } catch {
    return text.slice(0, 100).replace(/\s+/g, ' ')
  }
}

let hits = 0
for (const prefix of PREFIXES) {
  for (const path of PATHS) {
    const url = `${ORIGIN}${prefix}${path}`
    for (const method of ['GET', 'POST']) {
      const res = await call(url, method, method === 'POST' ? BODY : undefined)
      const isJson = /json/i.test(res.type)
      const mark = isJson ? 'JSON' : '    '
      console.log(`${String(res.status).padEnd(3)} ${mark} ${String(res.bytes).padStart(7)}B  ${method.padEnd(4)} ${prefix || '(root)'}${path}`)
      if (isJson && res.bytes > 20) {
        console.log(`        → ${shape(res.text)}`)
        if (res.status === 200) hits += 1
      }
      await sleep(1000)
    }
  }
}
console.log(`\n可用（200 + JSON）：${hits} 个`)
