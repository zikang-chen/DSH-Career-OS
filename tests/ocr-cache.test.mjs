import assert from'node:assert/strict'
import{it}from'node:test'
import{processKnowledgeOcr}from'../host/ocr.js'
it('never redownloads or replaces an existing human review on ordinary recognize',async()=>{const item={media:[{ocrStatus:'reviewed',ocr:{text:'人工修订',reviewed:true}}]};let download=0,writes=0;const repos={knowledge:{get:()=>item,updateMedia:()=>writes++}};const r=await processKnowledgeOcr({id:'k',action:'recognize'},{repos,config:{},download:async()=>{download++}});assert.equal(r.cache.hit,true);assert.equal(download,0);assert.equal(writes,0);assert.equal(r.image.ocr.text,'人工修订')})
