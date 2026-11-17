import assert from 'node:assert/strict'
import {it} from 'node:test'
import {parseNowcoderLinks,captureNowcoder} from '../host/nowcoder.js'
it('keeps actual nowcoder discussion URLs and dedupes summary anchors',()=>{
 const r=parseNowcoderLinks([{text:'腾讯产品经理面经',url:'https://www.nowcoder.com/discuss/123?sourceSSR=search'},{text:'同一帖摘要内容',url:'https://www.nowcoder.com/discuss/123'},{text:'首页',url:'https://www.nowcoder.com/'},{text:'不可信站链接',url:'https://evil.test/discuss/123'}]);assert.equal(r.length,1);assert.equal(r[0].url,'https://www.nowcoder.com/discuss/123');assert.equal(r[0].publishedAt,null)
})
it('returns list only when the detail container cannot be verified',async()=>{
 const r=await captureNowcoder({keyword:'腾讯',dryRun:true},{config:{dataDir:'unused'},captureText:async ({url})=>url.includes('/search')?{ok:true,links:[{text:'腾讯产品经理面经',url:'https://www.nowcoder.com/discuss/123'}]}:{ok:true,text:'导航没有正文',sections:[]}})
 assert.equal(r.ok,true);assert.equal(r.bodyFilled,0);assert.equal(r.bodyFailures.length,1);assert.equal(r.preview[0].desc,null)
})
