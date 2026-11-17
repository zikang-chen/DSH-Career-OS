// 本地OCR：仅处理知识库关联的公开图片；不上传第三方，不声称OCR等于人工确认。
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {CdpConnection,ensureBrowser} from './browser.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const sha=(b)=>createHash('sha256').update(b).digest('hex')
export function allowedImageUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&/(^|\.)(?:xhscdn\.com|xiaohongshu\.com|nowcoder\.com|nowcoder\.net)$/.test(u.hostname)}catch{return false}
}
async function runOcrProcess({dataDir,imagePath,status=false}){
 const dir=path.join(dataDir,'ocr');fs.mkdirSync(dir,{recursive:true})
 const output=path.join(dir,`${randomUUID()}.out.json`),error=output+'.err'
 const out=fs.openSync(output,'w'),err=fs.openSync(error,'w')
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','windows-ocr.ps1'),...(status?['-Status']:['-ImagePath',imagePath,'-Language','zh-Hans-CN'])]
 let code
 try{code=await new Promise((resolve,reject)=>{
   const child=spawn('powershell.exe',args,{stdio:['ignore',out,err],windowsHide:true})
   const timer=setTimeout(()=>{child.kill();reject(new Error('本地OCR超过30秒'))},30000)
   child.once('error',e=>{clearTimeout(timer);reject(e)})
   child.once('close',c=>{clearTimeout(timer);resolve(c)})
 })}finally{fs.closeSync(out);fs.closeSync(err)}
 const raw=fs.readFileSync(output,'utf8').replace(/^\uFEFF/,'')
 if(code!==0)throw new Error('本地OCR失败：'+fs.readFileSync(error,'utf8').slice(0,600))
 return JSON.parse(raw)
}
export async function ocrStatus({dataDir}){
 if(process.platform!=='win32')return {ok:false,error:'当前只接入Windows本地OCR，未安装其他引擎'}
 try{return await runOcrProcess({dataDir,status:true})}catch(e){return {ok:false,error:e.message}}
}
export async function downloadVisibleImage({url,dataDir}){
 if(!allowedImageUrl(url))throw new Error('图片必须来自已支持站点的HTTPS图片域名')
 const b=await ensureBrowser({dataDir});if(!b.ok)throw new Error(b.error)
 const info=await fetch(`http://127.0.0.1:${b.port}/json/version`).then(r=>r.json())
 const c=await new CdpConnection(info.webSocketDebuggerUrl).connect()
 let targetId,off
 try{
  ;({targetId}=await c.send('Target.createTarget',{url:'about:blank'}))
  const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true})
  const images=new Map();let imageBody=null
  off=c.on(m=>{
   if(m.sessionId!==sessionId)return
   if(m.method==='Network.responseReceived'){
    const r=m.params.response;if(/^image\//.test(r.mimeType??'')&&allowedImageUrl(r.url))images.set(m.params.requestId,r)
   }
   if(m.method==='Network.loadingFinished'&&images.has(m.params.requestId)&&!imageBody){
    imageBody=c.send('Network.getResponseBody',{requestId:m.params.requestId},sessionId,4000).then(body=>({body,mime:images.get(m.params.requestId).mimeType})).catch(()=>null)
   }
  })
  await c.send('Network.enable',{maxResourceBufferSize:12000000,maxTotalBufferSize:16000000},sessionId)
  await c.send('Page.navigate',{url},sessionId)
  const start=Date.now();while(!imageBody&&Date.now()-start<15000)await new Promise(r=>setTimeout(r,250))
  const found=imageBody?await imageBody:null
  if(!found?.body?.base64Encoded)throw new Error('图片正文未取得（可能链接过期/登录限制），不能把HTML存成原图')
  const bytes=Buffer.from(found.body.body,'base64')
  if(!bytes.length||bytes.length>12*1024*1024)throw new Error('图片为空或超过12MB限制')
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[found.mime]
  if(!ext)throw new Error('暂不支持此图片格式：'+found.mime)
  const hash=sha(bytes),dir=path.join(dataDir,'knowledge-media');fs.mkdirSync(dir,{recursive:true})
  const filePath=path.join(dir,hash+'.'+ext);fs.writeFileSync(filePath,bytes)
  return {filePath,sha256:hash,bytes:bytes.length,mime:found.mime}
 }finally{off?.();if(targetId)await c.send('Target.closeTarget',{targetId},undefined,1500).catch(()=>{});c.close()}
}
export async function processKnowledgeOcr({id,index=1,action='recognize',text},{repos,config,download=downloadVisibleImage,recognize=runOcrProcess}={}){
 const item=repos.knowledge.get(id);if(!item)throw new Error('知识库资料不存在')
 const media=Array.isArray(item.media)?structuredClone(item.media):[]
 const at=Number(index)-1;if(!Number.isInteger(at)||at<0||at>=media.length)throw new Error('图片序号无效')
 const image=media[at]
 if(action==='agent_prepare'){
   const original=image.original??await download({url:image.url,dataDir:config.dataDir})
   image.original=original
   repos.knowledge.updateMedia(id,media)
   return {ok:true,id,index,imagePath:original.filePath,sha256:original.sha256,localOcr:image.ocr?.rawText??image.ocr?.text??null,instruction:'使用read_image读取原图后逐字转录，结合本地OCR校错；看不清标〔无法辨认〕，不补造数字或题目。结果用agent_save保存，不能代人工确认。',privacy:'看图将图片交给当前模型服务；不同于本地OCR。'}
 }else if(action==='agent_save'){
   if(typeof text!=='string'||!text.trim())throw new Error('需要Agent实际读图后的文字')
   if(!image.original?.sha256)throw new Error('先准备并读取原图，不接受无图片证据的转录')
   image.agentTranscript={text:text.slice(0,30000),imageHash:image.original.sha256,createdAt:new Date().toISOString(),status:'ai-reviewed',humanConfirmed:false}
   image.ocrStatus='ai-reviewed'
 }else if(action==='review'){
  if(!image.ocr?.text&&!image.agentTranscript?.text)throw new Error('图片尚未识别，没有可核对文字')
   if(!image.ocr)image.ocr={text:image.agentTranscript.text,requiresReview:true}
  image.ocr={...image.ocr,rawText:image.ocr.rawText??image.ocr.text,text:text===undefined?image.ocr.text:String(text).slice(0,30000),reviewedAt:new Date().toISOString(),reviewed:true,requiresReview:false}
  image.ocrStatus='reviewed'
  if(image.agentTranscript)image.agentTranscript={...image.agentTranscript,humanConfirmed:true,humanConfirmedAt:new Date().toISOString()}
 }else if(action==='recognize'){
  try{
   const original=await download({url:image.url,dataDir:config.dataDir})
   const result=await recognize({dataDir:config.dataDir,imagePath:original.filePath})
   image.original=original
   image.ocr={...result,text:String(result.text??'').slice(0,30000),recognizedAt:new Date().toISOString(),reviewed:false,requiresReview:true,confidence:result.confidence??null}
   image.ocrStatus=result.text?.trim()?'review':'failed'
   if(image.ocrStatus==='failed')image.error='图片未识别出文字，原图仍保留'
  }catch(e){image.ocrStatus='failed';image.error=e.message}
 }else throw new Error('action必须recognize、agent_prepare、agent_save或review')
 return {ok:image.ocrStatus!=='failed',image,item:repos.knowledge.updateMedia(id,media),note:action==='agent_save'?'Agent校对稿独立保存，不是人工确认；模型读图可能使用云端服务。':'OCR独立于作者正文保存，本地识别未经核对不当作可靠逐字引文。'}
}
