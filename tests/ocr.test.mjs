import assert from 'node:assert/strict'
import {it} from 'node:test'
import {allowedImageUrl,processKnowledgeOcr} from '../host/ocr.js'
it('only accepts supported public HTTPS image domains',()=>{assert.equal(allowedImageUrl('https://sns-webpic-qc.xhscdn.com/example.jpg'),true);for(const u of ['http://x.xhscdn.com/a','https://127.0.0.1/a','file:///a','https://evil.test/a','https://user:pass@x.xhscdn.com/a'])assert.equal(allowedImageUrl(u),false)})
it('keeps OCR pending review and independent of author body',async()=>{
 let item={id:'k',body:'作者原文',media:[{index:1,url:'https://x.xhscdn.com/a'}]}
 const repos={knowledge:{get:()=>structuredClone(item),updateMedia:(id,media)=>(item={...item,media})}}
 const r=await processKnowledgeOcr({id:'k'},{repos,config:{dataDir:'unused'},download:async()=>({filePath:'image.png',sha256:'hash'}),recognize:async()=>({ok:true,text:'图中面试问题',confidence:null})})
 assert.equal(r.ok,true);assert.equal(item.body,'作者原文');assert.equal(item.media[0].ocrStatus,'review');assert.equal(item.media[0].ocr.reviewed,false)
 const reviewed=await processKnowledgeOcr({id:'k',action:'review',text:'人工核对后的图中文字'},{repos,config:{dataDir:'unused'}})
 assert.equal(reviewed.image.ocrStatus,'reviewed');assert.equal(item.body,'作者原文')
})
it('records failure without inventing OCR output',async()=>{let saved;const repos={knowledge:{get:()=>({media:[{url:'https://x.xhscdn.com/a'}]}),updateMedia:(id,media)=>{saved=media;return{media}}}};const r=await processKnowledgeOcr({id:'k'},{repos,config:{dataDir:'unused'},download:async()=>{throw new Error('图片失效')}});assert.equal(r.ok,false);assert.equal(saved[0].ocrStatus,'failed');assert.equal(saved[0].ocr,undefined)})
