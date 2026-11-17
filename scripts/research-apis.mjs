// Fetch public ATS API documentation and print a bounded, keyword-focused extract.
// Read-only, one request per host, no cookies, no login.
import { htmlToText } from '../host/sources.js'

const TARGETS = [
  { name: 'Greenhouse job board API', url: 'https://developers.greenhouse.io/job-board.html', keys: ['boards-api', '/v1/boards', 'content=true', 'job_boards'] },
  { name: 'Lever postings API', url: 'https://api.lever.co/v0/postings/leverdemo?mode=json', keys: [] },
  { name: 'Ashby public API', url: 'https://developers.ashbyhq.com/docs/public-job-posting-api', keys: ['posting-api', 'api.ashbyhq.com', 'jobPostings'] },
  { name: 'SmartRecruiters postings API', url: 'https://api.smartrecruiters.com/v1/companies/SmartRecruiters/postings?limit=2', keys: [] },
  { name: 'GitHub jobs-spec / OpenJobs', url: 'https://www.workatastartup.com/api/jobs', keys: [] },
]

const UA = 'Mozilla/5.0 (compatible; CareerOS/0.1; +local research)'

for (const target of TARGETS) {
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    })
    const raw = await res.text()
    const isJson = /^\s*[[{]/.test(raw)
    console.log(`\n=== ${target.name} ===`)
    console.log(`url=${target.url} status=${res.status} type=${res.headers.get('content-type')} bytes=${raw.length} json=${isJson}`)
    if (!res.ok) {
      console.log('  (non-2xx, stopping extract)')
      continue
    }
    if (isJson) {
      console.log('  json head:', raw.slice(0, 400).replace(/\s+/g, ' '))
      continue
    }
    const text = htmlToText(raw)
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const hits = new Set()
    for (const key of target.keys) {
      for (const line of lines) {
        if (line.toLowerCase().includes(key.toLowerCase())) hits.add(line.slice(0, 220))
        if (hits.size > 8) break
      }
    }
    if (!hits.size) {
      console.log('  no keyword hits; text head:', text.slice(0, 300).replace(/\s+/g, ' '))
    } else {
      for (const hit of [...hits].slice(0, 8)) console.log('  ·', hit)
    }
  } catch (err) {
    console.log(`\n=== ${target.name} ===\n  ERROR: ${String(err?.message ?? err).slice(0, 160)}`)
  }
}
