// Crawler extraction tests. All fixtures are local strings — no network is used.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractAnchorPostings,
  extractEmbeddedStatePostings,
  extractJsonLdPostings,
  extractPostings,
  looksLikeJobTitle,
  postingToJob,
} from '../host/crawl.js'
import { RECRUIT_LABEL, parseRecruitType } from '../host/domain.js'
import { makeEnv } from './helpers.mjs'

const BASE = 'https://jobs.example.com/campus'

const JSONLD_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "JobPosting",
      "title": "数据分析实习生（2027 秋招）",
      "description": "使用 SQL、Python 完成数据分析，参与 A/B测试；工作地点北京，每周 4 天。",
      "datePosted": "2026-09-01",
      "validThrough": "2026-10-31T23:59:59+08:00",
      "employmentType": "INTERN",
      "url": "/position/1001",
      "identifier": { "@type": "PropertyValue", "value": "JR-1001" },
      "hiringOrganization": { "@type": "Organization", "name": "示例科技" },
      "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress", "addressLocality": "北京", "addressRegion": "北京" } }
    },
    {
      "@type": "JobPosting",
      "title": "产品经理实习生",
      "description": "需求分析与原型设计，Figma",
      "url": "https://jobs.example.com/position/1002",
      "hiringOrganization": { "name": "示例科技" },
      "jobLocation": { "@type": "Place", "address": { "addressLocality": "上海" } }
    }
  ]
}
</script></head><body>正在招聘</body></html>`

const EMBEDDED_HTML = `<html><body>
<script>window.__INITIAL_STATE__ = {"jobList":[
  {"jobName":"数据分析实习生","city":"上海","jobId":"2001","url":"/job/2001","category":"数据"},
  {"jobName":"后端开发实习生","city":"深圳","jobId":"2002","url":"/job/2002"}
],"nav":{"name":"首页","url":"/"}};</script>
</body></html>`

const ANCHOR_HTML = `<html><body>
<div class="row"><span>北京</span><a href="/position/3001">数据分析实习生</a></div>
<div class="row"><span>上海</span><a href="/position/3002">产品经理实习生</a></div>
<div class="row"><a href="/about">关于我们</a></div>
<a href="/position/3001">数据分析实习生</a>
</body></html>`

const SPA_HTML = `<html><body><div id="app"></div><script src="/app.js"></script></body></html>`

describe('crawler extraction', () => {
  it('reads schema.org JobPosting JSON-LD including location and deadline', () => {
    const postings = extractJsonLdPostings(JSONLD_HTML, BASE)
    assert.equal(postings.length, 2)
    const first = postings[0]
    assert.match(first.title, /数据分析实习生/)
    assert.equal(first.company, '示例科技')
    assert.equal(first.location, '北京')
    assert.equal(first.deadline, '2026-10-31')
    assert.equal(first.jobCode, 'JR-1001')
    assert.equal(first.url, 'https://jobs.example.com/position/1001')
    assert.equal(postings[1].location, '上海')
  })

  it('reads embedded application state and skips nav objects', () => {
    const postings = extractEmbeddedStatePostings(EMBEDDED_HTML, BASE)
    assert.equal(postings.length, 2, 'nav entry must not become a posting')
    assert.equal(postings[0].title, '数据分析实习生')
    assert.equal(postings[0].location, '上海')
    assert.equal(postings[0].jobCode, '2001')
    assert.equal(postings[0].url, 'https://jobs.example.com/job/2001')
  })

  it('clusters detail anchors and picks the nearby city', () => {
    const postings = extractAnchorPostings(ANCHOR_HTML, BASE)
    assert.equal(postings.length, 2, 'about page and duplicate link are dropped')
    assert.equal(postings[0].location, '北京')
    assert.equal(postings[1].location, '上海')
  })

  it('prefers JSON-LD, then embedded state, then anchors', () => {
    assert.equal(extractPostings(JSONLD_HTML, BASE).strategy, 'jsonld')
    assert.equal(extractPostings(EMBEDDED_HTML, BASE).strategy, 'embedded')
    assert.equal(extractPostings(ANCHOR_HTML, BASE).strategy, 'anchors')
  })

  it('parses a raw JSON API response (the route for SPA job boards)', () => {
    const apiJson = JSON.stringify({
      code: 0,
      data: {
        total: 2,
        list: [
          { jobName: '数据分析实习生', city: '北京', jobId: '9001', url: '/position/9001', department: '数据平台' },
          { jobName: '产品经理实习生', city: '上海', jobId: '9002', url: '/position/9002' },
        ],
      },
    })
    const result = extractPostings(apiJson, BASE)
    assert.equal(result.strategy, 'json')
    assert.equal(result.postings.length, 2)
    assert.equal(result.postings[0].title, '数据分析实习生')
    assert.equal(result.postings[0].location, '北京')
    assert.equal(result.postings[0].department, '数据平台')
    assert.equal(result.postings[0].url, 'https://jobs.example.com/position/9001')
    assert.ok(result.warnings.some((w) => w.includes('JSON')))
  })

  it('says so when a JSON response has no recognisable job structure', () => {
    const result = extractPostings(JSON.stringify({ code: 0, data: { list: [] } }), BASE)
    assert.equal(result.strategy, 'none')
    assert.equal(result.postings.length, 0)
    assert.ok(result.warnings.some((w) => w.includes('JSON')))
  })

  it('admits a client-rendered page instead of inventing postings', () => {
    const result = extractPostings(SPA_HTML, BASE)
    assert.equal(result.strategy, 'none')
    assert.equal(result.postings.length, 0)
    assert.ok(result.warnings.some((w) => /纯客户端渲染|SPA|手动粘贴/.test(w)))
  })

  it('does not treat nav labels as job titles', () => {
    assert.equal(looksLikeJobTitle('首页'), false)
    assert.equal(looksLikeJobTitle('立即申请'), false)
    assert.equal(looksLikeJobTitle('12345'), false)
    assert.equal(looksLikeJobTitle('数据分析实习生'), true)
  })
})

describe('posting normalization', () => {
  it('carries location, apply URL and recruitment channel onto the job payload', () => {
    const posting = extractJsonLdPostings(JSONLD_HTML, BASE)[0]
    const job = postingToJob(posting, { company: '示例科技', pageUrl: BASE })
    assert.equal(job.location, '北京')
    assert.equal(job.applyUrl, 'https://jobs.example.com/position/1001')
    assert.equal(job.recruitType, 'autumn_campus')
    assert.equal(job.deadline, '2026-10-31')
    assert.ok(job.skills.includes('SQL'))
  })

  it('detects autumn / spring campus recruiting', () => {
    assert.equal(parseRecruitType('2027 秋季校园招聘正式启动'), 'autumn_campus')
    assert.equal(parseRecruitType('2027 春招'), 'spring_campus')
    assert.equal(parseRecruitType('暑期实习招聘'), 'summer')
    assert.equal(parseRecruitType('日常实习'), 'daily')
    assert.equal(RECRUIT_LABEL.autumn_campus, '秋招')
  })
})

describe('bulk import into the job store', () => {
  it('creates new postings and merges duplicates in one batch', () => {
    const env = makeEnv()
    try {
      const postings = [
        { title: '数据分析实习生', company: '示例科技', location: '北京', url: 'https://jobs.example.com/p/1', applyUrl: 'https://jobs.example.com/p/1' },
        { title: '数据分析实习生', company: '示例科技', location: '北京', url: 'https://jobs.example.com/p/1-copy', applyUrl: 'https://jobs.example.com/p/1-copy' },
        { title: '产品经理实习生', company: '示例科技', location: '上海', url: 'https://jobs.example.com/p/2', applyUrl: 'https://jobs.example.com/p/2' },
      ]
      const result = env.repos.jobs.importPostings(postings, { company: '示例科技', pageUrl: BASE, official: true })
      assert.equal(result.created.length, 2)
      assert.equal(result.merged.length, 1)
      assert.equal(result.failed.length, 0)
      assert.equal(Number(env.db.scalar('SELECT count(*) FROM job')), 2)
      const dataJob = env.db.get("SELECT id, location, recruit_type, apply_url, status FROM job WHERE title = '数据分析实习生'")
      const pmJob = env.db.get("SELECT location FROM job WHERE title = '产品经理实习生'")
      assert.equal(dataJob.location, '北京')
      assert.equal(pmJob.location, '上海')
      assert.equal(dataJob.status, 'OPEN', 'official page => official status evidence')
      const urls = env.repos.jobs.applyUrls(dataJob.id)
      assert.ok(urls.includes('https://jobs.example.com/p/1'))
    } finally {
      env.cleanup()
    }
  })

  it('reports a bad row without aborting the batch', () => {
    const env = makeEnv()
    try {
      const result = env.repos.jobs.importPostings([
        { title: '', company: '' },
        { title: '数据分析实习生', company: '示例科技', url: 'https://jobs.example.com/p/9' },
      ], { company: '示例科技', pageUrl: BASE, official: true })
      assert.equal(result.failed.length, 1)
      assert.equal(result.created.length, 1)
    } finally {
      env.cleanup()
    }
  })
})

describe('application list with apply address', () => {
  it('stores apply URL, location and deadline on the application record', () => {
    const env = makeEnv()
    try {
      const { id: jobId } = env.repos.jobs.upsertJob({
        company: '示例科技', title: '数据分析实习生', location: '北京',
        applyUrl: 'https://jobs.example.com/p/1', deadline: '2026-10-31',
        recruitType: 'autumn_campus', url: 'https://jobs.example.com/p/1',
      })
      const app = env.repos.applications.create({ jobId, status: 'applied', channel: '官网' })
      assert.equal(app.apply_url, 'https://jobs.example.com/p/1')
      assert.equal(app.location, '北京')
      assert.equal(app.deadline, '2026-10-31')
      assert.equal(app.recruit_type, 'autumn_campus')

      const filtered = env.repos.applications.list({ recruitType: ['autumn_campus'] })
      assert.equal(filtered.length, 1)
      assert.equal(env.repos.applications.list({ company: '不存在' }).length, 0)

      const csv = env.repos.applications.toCsv(filtered)
      assert.ok(csv.startsWith('\uFEFF'), 'BOM for Excel')
      assert.ok(csv.includes('投递地址'))
      assert.ok(csv.includes('https://jobs.example.com/p/1'))
      assert.ok(csv.includes('秋招'))
    } finally {
      env.cleanup()
    }
  })
})
