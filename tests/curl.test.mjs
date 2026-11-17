// cURL 解析 / 重放安全边界 / 响应形状描述。全部离线断言。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertReplayable, describeJsonShape, parseCurl, redactHeaders, tokenize } from '../host/curl.js'
import { walkJsonForPostings } from '../host/crawl.js'

describe('cURL parsing', () => {
  it('parses a bash "Copy as cURL" with headers and a POST body', () => {
    const curl = `curl 'https://jobs.example.com/api/search' \\
  -H 'content-type: application/json' \\
  -H 'cookie: sid=secret123' \\
  --data-raw '{"limit":10,"keywords":"产品"}'`
    const parsed = parseCurl(curl)
    assert.equal(parsed.ok, true, parsed.problems.join(';'))
    assert.equal(parsed.url, 'https://jobs.example.com/api/search')
    assert.equal(parsed.method, 'POST', 'body implies POST when -X is absent')
    assert.equal(parsed.headers['content-type'], 'application/json')
    assert.equal(parsed.headers.cookie, 'sid=secret123')
    assert.equal(parsed.body, '{"limit":10,"keywords":"产品"}')
  })

  it('parses a cmd copy with ^ continuations and double quotes', () => {
    const curl = `curl "https://jobs.example.com/api/list" ^
  -H "accept: application/json" ^
  -X GET`
    const parsed = parseCurl(curl)
    assert.equal(parsed.ok, true, parsed.problems.join(';'))
    assert.equal(parsed.url, 'https://jobs.example.com/api/list')
    assert.equal(parsed.method, 'GET')
    assert.equal(parsed.headers.accept, 'application/json')
    assert.equal(parsed.body, null)
  })

  it('keeps the URL intact when it carries query parameters', () => {
    const parsed = parseCurl(`curl 'https://a.com/api?page=2&size=20' -H 'x-y: z'`)
    assert.equal(parsed.url, 'https://a.com/api?page=2&size=20')
  })

  it('refuses commands that are not curl', () => {
    const parsed = parseCurl('wget https://example.com')
    assert.equal(parsed.ok, false)
    assert.match(parsed.problems.join(' '), /不是 curl 命令/)
  })

  it('refuses -u credentials and asks for a cookie-based copy instead', () => {
    const parsed = parseCurl(`curl -u user:pass 'https://example.com/api'`)
    assert.equal(parsed.ok, false)
    assert.match(parsed.problems.join(' '), /-u/)
  })

  it('warns that a cookie-bearing command should not be shared', () => {
    const parsed = parseCurl(`curl 'https://a.com' -H 'Cookie: sid=1'`)
    assert.equal(parsed.ok, true)
    assert.match(parsed.warnings.join(' '), /不要外传/)
  })

  it('reports a missing URL instead of guessing', () => {
    const parsed = parseCurl(`curl -H 'a: b'`)
    assert.equal(parsed.ok, false)
    assert.match(parsed.problems.join(' '), /没有找到请求地址/)
  })

  it('tokenizes quotes and escapes like a shell would', () => {
    assert.deepEqual(tokenize(`a 'b c' "d e" f\\ g`), ['a', 'b c', 'd e', 'f g'])
  })
})

describe('replay safety guard', () => {
  it('allows a normal https endpoint', () => {
    assert.equal(assertReplayable({ url: 'https://jobs.example.com/api', method: 'POST' }).ok, true)
  })

  it('blocks non-http protocols, loopback and private networks', () => {
    for (const url of ['file:///C:/secret.txt', 'http://localhost:8080/api', 'http://127.0.0.1/x', 'http://192.168.1.10/api', 'http://10.0.0.5/api', 'http://172.16.3.4/api']) {
      const guard = assertReplayable({ url, method: 'GET' })
      assert.equal(guard.ok, false, `${url} should be blocked`)
    }
  })

  it('blocks destructive methods and credentials embedded in the URL', () => {
    assert.equal(assertReplayable({ url: 'https://a.com/x', method: 'DELETE' }).ok, false)
    assert.equal(assertReplayable({ url: 'https://user:pw@a.com/x', method: 'GET' }).ok, false)
  })
})

describe('header redaction', () => {
  it('never echoes cookies or tokens', () => {
    const redacted = redactHeaders({ Cookie: 'sid=supersecret', Authorization: 'Bearer abcdef', Accept: 'application/json' })
    assert.ok(!JSON.stringify(redacted).includes('supersecret'))
    assert.ok(!JSON.stringify(redacted).includes('abcdef'))
    assert.match(redacted.Cookie, /已脱敏/)
    assert.equal(redacted.Accept, 'application/json')
  })
})

describe('response shape description', () => {
  it('describes nested JSON so the user can see what they actually grabbed', () => {
    const shape = describeJsonShape({ code: 0, data: { list: [{ title: '产品经理', city: '北京' }], total: 1 } })
    assert.match(shape, /code/)
    assert.match(shape, /数组\(1\)/)
    assert.match(shape, /产品经理/)
  })

  it('handles primitives and null without throwing', () => {
    assert.equal(describeJsonShape(null), 'null')
    assert.equal(describeJsonShape(7), '7')
    assert.match(describeJsonShape('abc'), /abc/)
  })
})

describe('extraction from a pasted response', () => {
  it('finds postings inside a typical {code,data:{list:[]}} envelope', () => {
    const payload = {
      code: 0,
      data: {
        list: [
          { job_name: '产品经理实习生', city_name: '北京', job_id: '1001' },
          { job_name: '数据分析实习生', city_name: '上海', job_id: '1002' },
        ],
        total: 2,
      },
    }
    const postings = walkJsonForPostings(payload, 'https://jobs.example.com/api')
    assert.equal(postings.length, 2)
    assert.equal(postings[0].title, '产品经理实习生')
    assert.equal(postings[0].location, '北京')
  })

  it('returns nothing (not garbage) for a config-like response', () => {
    const postings = walkJsonForPostings({ code: 0, data: { dictionary: [{ key: 'city', label: '城市' }] } }, 'https://a.com')
    assert.equal(postings.length, 0)
  })
})
