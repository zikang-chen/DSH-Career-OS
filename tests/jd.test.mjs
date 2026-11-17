// JD 补全：提供方解析、字段提取、缺字段处理。全部离线（不联网）。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JD_PROVIDERS, extractJdFromText, fetchJdDetail, resolveJdProvider } from '../host/jd.js'

const description = '负责业务数据分析、指标体系设计与看板搭建，协同产品和研发团队完成数据治理，持续跟踪核心业务指标并形成可落地的改进方案。'
const requirements = '本科及以上学历，熟练掌握 SQL 与数据分析方法，具备独立解决问题、跨团队沟通和清晰表达分析结论的能力。'
const jdText = `岗位职责\n${description}\n任职要求\n${requirements}`
const assertNoJd = (result) => {
  assert.equal(result.description, null)
  assert.equal(result.requirements, null)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
}

describe('jd text extraction (page mode)', () => {
  it('splits explicit 职位信息 / 任职要求 headings and excludes footer sections', () => {
    const out = extractJdFromText(`某职位\n职位信息\n${description}\n任职要求\n${requirements}\n福利待遇\n五险一金\n公司信息\n介绍`)
    assert.equal(out.description, description)
    assert.equal(out.requirements, requirements)
  })

  it('rejects the old longest-paragraph fallback instead of calling it JD', () => {
    assertNoJd(extractJdFromText('导航\n\n' + '这是一段很长但没有明确职责或要求标题的页面内容，'.repeat(10)))
    assertNoJd(extractJdFromText('高级数据分析师招聘\n\n' + '隐私政策与用户协议，请认真阅读本网站的服务条款。'.repeat(10)))
  })

  it('does not treat a heading word embedded in prose as a section', () => {
    assertNoJd(extractJdFromText(`这里介绍职位描述及任职要求等常见栏目的使用方法。${description}${requirements}`))
  })

  it('supports explicit inline, bracketed and numbered headings', () => {
    const out = extractJdFromText(`一、【岗位职责】：${description}\n2. 任职要求：${requirements}\n工作地址：北京`)
    assert.equal(out.description, description)
    assert.equal(out.requirements, requirements)
  })

  it('accepts a real requirements-only section, not just a title', () => {
    const out = extractJdFromText(`数据分析师\n任职资格\n${requirements}`)
    assert.equal(out.description, null)
    assert.equal(out.requirements, requirements)
  })

  it('leaves empty, headings-only, punctuation-only and tiny bodies empty with errors', () => {
    for (const text of ['', null, '数据分析师\n岗位职责\n任职要求\n福利待遇', '岗位职责\n负责分析。', `岗位职责\n${'，。！ '.repeat(100)}`]) {
      assertNoJd(extractJdFromText(text))
    }
  })

  it('rejects login, captcha and rate-limit text even when JD headings are present', () => {
    for (const blocker of ['请先登录后查看完整职位描述', '请完成安全验证', '拖动滑块完成验证', '访问过于频繁，请稍后再试', '429 Too Many Requests']) {
      assertNoJd(extractJdFromText(`${jdText}\n${blocker}`))
    }
  })

  it('preserves long JD sections up to 20000 characters, not the old 1500/2000 limit', () => {
    const longBody = `${description.repeat(90)}最后一条真实职责。`
    const out = extractJdFromText(`岗位职责\n${longBody}\n任职要求\n${requirements}`)
    assert.ok(longBody.length > 2000)
    assert.equal(out.description, longBody)
    assert.equal(out.requirements, requirements)
    assert.equal(extractJdFromText(`岗位职责\n${description.repeat(600)}`).description.length, 20000)
  })

  it('routes 51job/boss to explicit page-mode DOM selectors', () => {
    for (const applyUrl of ['https://jobs.51job.com/x/1.html', 'https://www.zhipin.com/job_detail/a.html']) {
      const provider = resolveJdProvider({ applyUrl })
      assert.equal(provider?.mode, 'page')
      assert.ok(provider.selectors.length > 0)
      assert.ok(provider.selectors.every((selector) => typeof selector === 'string' && !/^(body|main|h1)$/.test(selector)))
    }
  })
})

describe('jd provider resolution', () => {
  it('recognises Tencent campus by host', () => {
    const provider = resolveJdProvider({ applyUrl: 'https://join.qq.com/post.html?id=22469' })
    assert.equal(provider?.key, 'tencent-campus')
    assert.equal(provider.need, 'postId')
  })

  it('returns null for unknown sites instead of guessing an endpoint', () => {
    assert.equal(resolveJdProvider({ applyUrl: 'https://jobs.example.com/x' }), null)
    assert.equal(resolveJdProvider({}), null)
  })

  it('builds the Tencent detail url from postId', () => {
    const provider = JD_PROVIDERS.find((p) => p.key === 'tencent-campus')
    assert.equal(
      provider.buildUrl({ postId: '1282707398326592512' }),
      'https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId=1282707398326592512',
    )
  })
})

describe('tencent response mapping', () => {
  const provider = JD_PROVIDERS.find((p) => p.key === 'tencent-campus')

  it('extracts description / requirements / cities', () => {
    const picked = provider.pick({
      status: 0,
      data: { title: 'AI全栈工程师', tidName: '技术', desc: '负责全栈开发', request: '熟练掌握前后端', workCityList: ['深圳总部', '北京'] },
    })
    assert.equal(picked.description, '负责全栈开发')
    assert.equal(picked.requirements, '熟练掌握前后端')
    assert.equal(picked.location, '深圳总部 北京')
    assert.equal(picked.department, '技术')
  })

  it('returns null when the payload has no JD body', () => {
    assert.equal(provider.pick({ status: 0, data: {} }), null)
    assert.equal(provider.pick({}), null)
  })

  it('keeps the original Tencent API parameters and request mapping (mocked fetch)', async (t) => {
    let requested
    t.mock.method(globalThis, 'fetch', async (requestUrl, options) => {
      requested = { requestUrl, options }
      return { ok: true, json: async () => ({ data: { desc: '负责全栈开发', request: '熟练掌握前后端', title: '全栈工程师', workCityList: ['深圳'] } }) }
    })
    const result = await fetchJdDetail({ provider, postId: 'offline-post-id', timeoutMs: 1000 })
    assert.equal(result.ok, true)
    assert.equal(result.description, '负责全栈开发')
    assert.equal(result.requirements, '熟练掌握前后端')
    assert.equal(result.title, '全栈工程师')
    assert.equal(result.location, '深圳')
    assert.equal(requested.requestUrl, provider.buildUrl({ postId: 'offline-post-id' }))
    assert.equal(requested.options.headers.referer, provider.referer)
  })

  it('keeps Tencent HTTP failures as failures rather than falling back to a page', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403 }))
    const result = await fetchJdDetail({ provider, postId: 'offline-post-id' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'HTTP 403')
  })
})

describe('fetchJdDetail page validation (injected capture only, no browser)', () => {
  const providers = JD_PROVIDERS.filter((provider) => provider.mode === 'page')
  const provider = providers.find((item) => item.key === 'boss-page')
  const url = 'https://www.zhipin.com/job_detail/offline.html'
  const page = (overrides = {}) => ({ ok: true, url, title: '数据分析师 - BOSS直聘', text: jdText, sections: [], ...overrides })
  const run = (captured) => fetchJdDetail({ provider, url, captureText: async () => captured })

  for (const current of providers) {
    it(`passes ${current.key} selectors to captureText and trusts only its DOM body`, async () => {
      const detailUrl = current.key === '51job-page' ? 'https://jobs.51job.com/beijing/123.html' : url
      let received
      const longBody = `${description.repeat(70)}最后一条职责不能丢。`
      const result = await fetchJdDetail({
        provider: current, url: detailUrl, dataDir: 'offline-only', timeoutMs: 1000,
        captureText: async (input) => {
          received = input
          return page({ url: detailUrl, text: '首页\n登录\n注册\n用户服务条款', sections: [{ selector: current.selectors[0], text: longBody }] })
        },
      })
      assert.deepEqual(received, { dataDir: 'offline-only', url: detailUrl, timeoutMs: 12000, selectors: current.selectors })
      assert.equal(result.ok, true)
      assert.equal(result.description, longBody)
      assert.equal(result.requirements, null)
      assert.equal(result.pageTitle, '数据分析师 - BOSS直聘')
    })
  }

  it('prioritises matched JD DOM over unrelated headed page text', async () => {
    const result = await run(page({
      text: `岗位职责\n${'这是整页推荐职位而非当前岗位。'.repeat(10)}`,
      sections: [{ selector: provider.selectors[0], text: jdText }],
    }))
    assert.equal(result.ok, true)
    assert.equal(result.description, description)
    assert.equal(result.requirements, requirements)
  })

  it('deduplicates nested DOM matches while keeping all actual JD content', async () => {
    const result = await run(page({ sections: [
      { selector: provider.selectors[0], text: jdText },
      { selector: provider.selectors[1], text: description },
      { selector: provider.selectors[0], text: jdText },
    ] }))
    assert.equal(result.ok, true)
    assert.equal(result.description, description)
    assert.equal(result.requirements, requirements)
  })

  it('keeps header-less trusted DOM text bounded at 20000 characters', async () => {
    const result = await run(page({ sections: [{ selector: provider.selectors[0], text: description.repeat(600) }] }))
    assert.equal(result.ok, true)
    assert.equal(result.description.length, 20000)
  })

  it('supports legacy capture results without sections only with explicit substantial JD headings', async () => {
    const result = await run(page({ sections: undefined }))
    assert.equal(result.ok, true)
    assert.equal(result.description, description)
    assert.equal(result.requirements, requirements)
  })

  it('does not trust arbitrary selectors or use pageTitle as the JD body', async () => {
    for (const captured of [
      page({ text: '', title: description, sections: [] }),
      page({ text: description, sections: [] }),
      page({ text: '数据分析师', sections: [{ selector: 'body', text: description }] }),
      page({ text: '数据分析师', sections: [{ selector: '.unknown-content', text: jdText }] }),
      page({ sections: [{ selector: provider.selectors[0], text: '数据分析师' }] }),
      page({ sections: [{ selector: provider.selectors[0], text: '岗位职责\n任职要求\n福利待遇\n公司信息' }] }),
    ]) {
      const result = await run(captured)
      assert.equal(result.ok, false)
      assertNoJd(result)
    }
  })

  it('rejects blocked URLs, titles and full-page errors even when a valid-looking section remains', async () => {
    const blockedPages = [
      { url: 'https://www.zhipin.com/web/user/?redirect=/job_detail/offline.html' },
      { url: 'https://passport.51job.com/login.php' },
      { url: 'https://www.zhipin.com/web/common/security-check.html' },
      { url: 'chrome-error://chromewebdata/' },
      { title: '登录 - BOSS直聘' },
      { title: '安全验证 - BOSS直聘' },
      { title: 'Security Check' },
      { title: '403 Forbidden' },
      { text: '请先登录' },
      { text: '请先登录后查看完整职位信息。' },
      { text: 'Please sign in to view the full job description.' },
      { text: '请完成验证后继续访问。' },
      { text: '请输入手机验证码后继续。' },
      { text: '访问过于频繁，请稍后再试。' },
      { text: '请求频率过高，请稍后再试。' },
      { text: '检测到异常访问，当前访问受限。' },
      { text: '系统繁忙，请稍后重试。' },
      { text: '404 Not Found' },
      { text: 'Access denied. Please contact the administrator.' },
      { text: '职位已下架，请查看其他相似职位。' },
    ]
    for (const blocked of blockedPages) {
      const result = await run(page({ sections: [{ selector: provider.selectors[0], text: jdText }], ...blocked }))
      assert.equal(result.ok, false, JSON.stringify(blocked))
      assertNoJd(result)
    }
  })

  it('rejects blocker messages inside a known DOM body rather than blessing the selector', async () => {
    for (const text of ['请登录后查看完整职位描述。'.repeat(10), '请完成安全验证后继续访问。'.repeat(10), '请求过于频繁，请稍后再试。'.repeat(10)]) {
      const result = await run(page({ text: '数据分析师', sections: [{ selector: provider.selectors[0], text }] }))
      assert.equal(result.ok, false)
      assertNoJd(result)
    }
  })

  it('allows ordinary login navigation and job duties concerning login/captcha systems', async () => {
    const body = `${description}参与用户登录、验证码服务的设计与可用性监控，建立统一鉴权体系。`
    const result = await run(page({ text: `首页\n登录\n注册\n${body}`, sections: [{ selector: provider.selectors[0], text: body }] }))
    assert.equal(result.ok, true)
    assert.equal(result.description, body)
  })

  it('refuses a final URL outside the provider rather than inventing a JD source', async () => {
    const result = await run(page({ url: 'https://example.com/some-article' }))
    assert.equal(result.ok, false)
    assertNoJd(result)
    assert.match(result.error, /其他站点/)
  })

  it('returns explicit errors for failed, empty and throwing capture results', async () => {
    for (const captured of [{ ok: false, error: '离线读取失败' }, null, page({ text: '', sections: [] })]) {
      const result = await run(captured)
      assert.equal(result.ok, false)
      assertNoJd(result)
    }
    const result = await fetchJdDetail({ provider, url, captureText: async () => { throw new Error('offline failure') } })
    assert.equal(result.ok, false)
    assertNoJd(result)
    assert.match(result.error, /offline failure/)
  })
})

describe('fetchJdDetail guards', () => {
  it('refuses without a provider', async () => {
    const result = await fetchJdDetail({ provider: null })
    assert.equal(result.ok, false)
    assert.equal(result.unsupported, true)
  })

  it('refuses when postId is missing (list API did not give it)', async () => {
    const provider = JD_PROVIDERS.find((p) => p.key === 'tencent-campus')
    const result = await fetchJdDetail({ provider, postId: null })
    assert.equal(result.ok, false)
    assert.match(result.error, /postId/)
  })

  it('requires a URL and keeps the real-browser dataDir guard without launching a browser', async () => {
    const provider = JD_PROVIDERS.find((p) => p.key === 'boss-page')
    const missingUrl = await fetchJdDetail({ provider, captureText: async () => { assert.fail('must not capture without URL') } })
    assert.equal(missingUrl.ok, false)
    assertNoJd(missingUrl)
    assert.match(missingUrl.error, /URL/)
    const missingDataDir = await fetchJdDetail({ provider, url: 'https://www.zhipin.com/job_detail/offline.html' })
    assert.equal(missingDataDir.ok, false)
    assertNoJd(missingDataDir)
    assert.match(missingDataDir.error, /dataDir/)
  })
})
