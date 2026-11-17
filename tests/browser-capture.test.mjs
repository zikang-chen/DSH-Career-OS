import assert from 'node:assert/strict'
import {describe,it} from 'node:test'
import {watchJsonResponses,publicBrowserUrl,CdpConnection} from '../host/browser.js'
class FakeCdp {
  constructor(bodies){this.bodies=bodies;this.listeners=new Set();this.calls=[]}
  on(f){this.listeners.add(f);return()=>this.listeners.delete(f)}
  send(method,p){this.calls.push({method,...p});return this.bodies[p.requestId] instanceof Error?Promise.reject(this.bodies[p.requestId]):Promise.resolve({body:JSON.stringify(this.bodies[p.requestId])})}
  emit(method,params,sessionId='s'){for(const f of this.listeners)f({method,params,sessionId})}
  response(id,url){this.emit('Network.responseReceived',{requestId:id,response:{url,status:200,mimeType:'application/json'}})}
  done(id){this.emit('Network.loadingFinished',{requestId:id,encodedDataLength:120})}
}
const flush=()=>new Promise(r=>setImmediate(r))
describe('durable capture lifecycle',()=>{
  it('retrieves at loadingFinished, never before the response finishes',async()=>{
    const c=new FakeCdp({one:{jobs:[1]}})
    const w=watchJsonResponses(c,'s',{patterns:['jobs'],validateJson:j=>j.jobs?.length>0})
    c.response('one','https://example.com/api/jobs/search')
    assert.equal(c.calls.length,0)
    c.done('one');await flush()
    assert.equal(w.best().json.jobs.length,1)
    assert.equal(c.calls[0].requestId,'one')
    w.dispose();assert.equal(c.listeners.size,0)
  })
  it('rejects arbitrary JSON even when its URL wins the heuristic',async()=>{
    const c=new FakeCdp({config:{data:'configuration'},list:{jobs:[1]}})
    const w=watchJsonResponses(c,'s',{patterns:['job','search'],validateJson:j=>j.jobs?.length>0})
    c.response('config','https://example.com/api/job/search/config-extra');c.done('config')
    c.response('list','https://example.com/api/job/search');c.done('list');await flush()
    assert.equal(w.best().requestId,'list');w.dispose()
  })
  it('can still select a later good response after one body is evicted',async()=>{
    const c=new FakeCdp({bad:new Error('No resource with given identifier found'),good:{jobs:[1]}})
    const w=watchJsonResponses(c,'s',{patterns:['job'],validateJson:j=>j.jobs?.length>0})
    for(const id of ['bad','good']){c.response(id,'https://a.test/api/job/search');c.done(id)}
    await flush();assert.equal(w.best().requestId,'good');assert.ok(w.candidates().some(c=>/No resource/.test(c.error??'')));w.dispose()
  })
  it('does not leak session tickets in diagnostics',()=>{
    const u=publicBrowserUrl('https://a.test/job?keyword=AI&securityId=secret&token=secret&lid=private')
    assert.ok(u.includes('keyword=AI'));assert.ok(!u.includes('secret'));assert.ok(!u.includes('private'))
  })
  it('clears pending CDP timers and rejects when the connection closes',async()=>{
    const c=new CdpConnection('ws://unused');c.socket={send(){},close(){}}
    const result=c.send('Page.navigate',{},null,60000)
    c.close();await assert.rejects(result,/连接已关闭/);assert.equal(c.pending.size,0)
  })
})
