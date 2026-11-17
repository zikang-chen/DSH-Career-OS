// JD 补全：提供方解析、字段提取、缺字段处理。全部离线（不联网）。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JD_PROVIDERS, fetchJdDetail, resolveJdProvider } from '../host/jd.js'

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
})
