import assert from 'node:assert/strict'
import {it} from 'node:test'
import {processKnowledgeOcr} from '../host/ocr.js'
it('stores agent transcription separately and never claims human confirmation',async()=>{
 let item={body:'作者原文',media:[{url:'https://x.xhscdn.com/a',original:{filePath:'a.png',sha256:'image-hash'},ocr:{text:'胶招',rawText:'胶招'}}]}
 const repos={knowledge:{get:()=>structuredClone(item),updateMedia:(id,media)=>(item={...item,media})}},config={dataDir:'unused'}
 const p=await processKnowledgeOcr({id:'k',action:'agent_prepare'},{repos,config});assert.equal(p.imagePath,'a.png')
 await processKnowledgeOcr({id:'k',action:'agent_save',text:'校招'},{repos,config})
 assert.equal(item.media[0].ocr.text,'胶招');assert.equal(item.media[0].agentTranscript.text,'校招');assert.equal(item.media[0].agentTranscript.humanConfirmed,false);assert.equal(item.body,'作者原文')
})
