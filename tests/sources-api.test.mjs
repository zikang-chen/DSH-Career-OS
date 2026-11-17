// 招聘系统接口适配器 + 取数指引：全部离线，断言 URL 构造与字段映射。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ATS_SPECS, detectAts, normalizeAtsPayload } from '../host/ats.js'
import { buildRetrievalGuide } from '../host/guide.js'

describe('ATS detection', () => {
  it('recognises the documented board URLs', () => {
    assert.deepEqual(
      { ats: detectAts('https://boards.greenhouse.io/acme').ats, token: detectAts('https://boards.greenhouse.io/acme').token },
      { ats: 'greenhouse', token: 'acme' },
    )
    assert.equal(detectAts('https://jobs.lever.co/acme').token, 'acme')
    assert.equal(detectAts('https://jobs.lever.co/acme').ats, 'lever')
    assert.equal(detectAts('https://jobs.ashbyhq.com/acme').ats, 'ashby')
    assert.equal(detectAts('https://jobs.ashbyhq.com/acme').token, 'acme')
    assert.equal(detectAts('https://jobs.smartrecruiters.com/acme').ats, 'smartrecruiters')
    assert.equal(detectAts('https://jobs.smartrecruiters.com/acme').token, 'acme')

    const workday = detectAts('https://acme.wd5.myworkdayjobs.com/External')
    assert.equal(workday.ats, 'workday')
    assert.equal(workday.token, 'acme/wd5/External')
    assert.equal(workday.spec.api(workday.token), 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs')
  })

  it('builds the exact public API URL for each platform', () => {
    assert.equal(ATS_SPECS.greenhouse.api('acme'), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true')
    assert.equal(ATS_SPECS.lever.api('acme'), 'https://api.lever.co/v0/postings/acme?mode=json')
    assert.equal(ATS_SPECS.ashby.api('acme'), 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true')
    assert.equal(ATS_SPECS.smartrecruiters.api('acme'), 'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100')
  })

  it('returns null for pages that are not a known ATS', () => {
    assert.equal(detectAts('https://jobs.bytedance.com/campus'), null)
    assert.equal(detectAts('not a url'), null)
    assert.equal(detectAts(''), null)
  })
})

describe('ATS payload normalisation', () => {
  it('maps a Greenhouse board payload', () => {
    const postings = normalizeAtsPayload('greenhouse', {
      jobs: [{
        id: 42,
        title: 'Data Analyst Intern',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/42',
        location: { name: 'Beijing' },
        departments: [{ name: 'Data' }],
        content: '<p>Use SQL &amp; Python</p>',
        updated_at: '2026-09-01T00:00:00Z',
      }],
    })
    assert.equal(postings.length, 1)
    assert.equal(postings[0].title, 'Data Analyst Intern')
    assert.equal(postings[0].location, 'Beijing')
    assert.equal(postings[0].department, 'Data')
    assert.equal(postings[0].jobCode, '42')
    assert.ok(postings[0].description.includes('SQL'))
    assert.equal(postings[0].via, 'ats:greenhouse')
  })

  it('maps a Lever postings payload (nested categories)', () => {
    const postings = normalizeAtsPayload('lever', [{
      id: 'abc',
      text: '数据分析实习生',
      hostedUrl: 'https://jobs.lever.co/acme/abc',
      categories: { location: '上海', team: 'Data', commitment: 'Intern' },
      createdAt: 1756684800000,
      descriptionPlain: '使用 SQL 与 Python',
    }])
    assert.equal(postings.length, 1)
    assert.equal(postings[0].title, '数据分析实习生')
    assert.equal(postings[0].location, '上海')
    assert.equal(postings[0].department, 'Data')
    assert.match(postings[0].publishedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('maps SmartRecruiters and Ashby payloads', () => {
    const sr = normalizeAtsPayload('smartrecruiters', {
      company: { identifier: 'acme' },
      content: [{ id: '744', name: '产品经理实习生', refNumber: 'REF1', releasedDate: '2026-10-28T15:14:43.941Z', location: { city: 'Beijing' }, department: { label: 'Product' } }],
    })
    assert.equal(sr[0].title, '产品经理实习生')
    assert.equal(sr[0].location, 'Beijing')
    assert.equal(sr[0].jobCode, 'REF1')

    const ashby = normalizeAtsPayload('ashby', { jobs: [{ title: 'Backend Intern', location: 'Shenzhen', jobUrl: 'https://jobs.ashbyhq.com/acme/1', department: 'Eng' }] })
    assert.equal(ashby[0].location, 'Shenzhen')
    assert.equal(ashby[0].url, 'https://jobs.ashbyhq.com/acme/1')
  })

  it('drops rows without a title instead of inventing one', () => {
    const postings = normalizeAtsPayload('lever', [{ id: 'x' }, { text: '有标题的岗位', hostedUrl: 'u' }])
    assert.equal(postings.length, 1)
    assert.equal(postings[0].title, '有标题的岗位')
  })

  it('returns nothing for an unknown platform', () => {
    assert.deepEqual(normalizeAtsPayload('mystery', { jobs: [{ title: 'x' }] }), [])
  })
})

describe('retrieval guide', () => {
  it('gives a ready-to-paste API URL when the site runs on a known ATS', () => {
    const guide = buildRetrievalGuide({ company: 'Acme', url: 'https://jobs.lever.co/acme' })
    assert.equal(guide.detectedAts.ats, 'lever')
    assert.equal(guide.detectedAts.apiUrl, 'https://api.lever.co/v0/postings/acme?mode=json')
    const first = guide.steps[0]
    assert.match(first.title, /Lever/)
    assert.equal(first.copy, 'https://api.lever.co/v0/postings/acme?mode=json')
    assert.ok(guide.copyableUrls.some((c) => c.url === guide.detectedAts.apiUrl))
  })

  it('gives concrete click-by-click steps when the ATS is unknown', () => {
    const guide = buildRetrievalGuide({ company: '示例科技', url: 'https://jobs.example.com/campus' })
    assert.equal(guide.detectedAts, null)
    const all = guide.steps.map((s) => `${s.title}${s.detail}`).join(' ')
    assert.match(all, /F12|Network|Fetch\/XHR/, 'must explain how to find the JSON request')
    assert.match(all, /Copy link address|复制/, 'must say what to copy')
    assert.match(all, /career_jobs_crawl/, 'must say where to paste it back')
    assert.ok(guide.steps.length >= 4)
    assert.ok(guide.pasteTemplate.includes('接口或页面地址'))
  })

  it('suggests candidate official entry points for a known employer', () => {
    const guide = buildRetrievalGuide({ company: '字节跳动' })
    assert.ok(guide.knownEntries.length >= 2)
    assert.ok(guide.knownEntries.every((u) => u.startsWith('http')))
  })

  it('matches a legal-name variant to the known employer', () => {
    const guide = buildRetrievalGuide({ company: '北京字节跳动科技有限公司' })
    assert.ok(guide.knownEntries.some((u) => u.includes('jobs.bytedance.com')))
  })

  it('always states the collection policy and never promises blocked sources', () => {
    const guide = buildRetrievalGuide({ company: '示例科技' })
    assert.match(guide.note, /公开|robots/)
    assert.match(guide.note, /不会编造/)
    assert.ok(Array.isArray(guide.socialLinks))
  })

  it('lists the known ATS catalogue with their docs', () => {
    const guide = buildRetrievalGuide({})
    const keys = guide.atsCatalog.map((c) => c.ats)
    for (const expected of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday']) {
      assert.ok(keys.includes(expected), `catalogue missing ${expected}`)
    }
  })
})
