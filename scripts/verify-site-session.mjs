// 低频真实站点验收；只读/预览，不入库，不打印 Cookie、会话票据或响应原文。
// node scripts/verify-site-session.mjs <site> <keyword> [recruitType]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capturePageJson, capturePageText, ensureBrowser } from '../host/browser.js'
import { getSiteProfile, classifyRecruitType } from '../host/sites.js'
import { fetchJdDetail, resolveJdProvider } from '../host/jd.js'
import { fetchXhsNoteBody } from '../host/site-capture.js'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
const [site = '51job', keyword = '产品经理', recruitType] = process.argv.slice(2)
const p = getSiteProfile(site)
if (!p) throw new Error('未知站点')
const search = p.searchPlan ? p.searchPlan({keyword,recruitType}) : {url:p.searchUrl({keyword})}
const boot = await ensureBrowser({dataDir,noProxy:false})
console.log(JSON.stringify({phase:'browser',ok:boot.ok,started:boot.started,network:'system-proxy'}))
const cap = await capturePageJson({dataDir,url:search.url,patterns:p.patterns,prefer:p.prefer,search:p.searchUi?{selector:p.searchUi,keyword:search.searchKeyword??keyword}:undefined,validateJson:(json,url)=>p.parse(json).length > 0 && (site==='xhs' ? /search\/notes/.test(url) : !p.prefer || new RegExp(p.prefer,'i').test(url)),timeoutMs:18000})
const items = cap.ok ? p.parse(cap.captured.json) : []
const out = {site,keyword,recruitType:recruitType??null,checkedAt:new Date().toISOString(),ok:cap.ok,stage:cap.stage,error:cap.error,page:cap.page,sourceUrl:cap.captured?.url,found:items.length,matched:items.filter(it=>!recruitType||classifyRecruitType(it)===recruitType).length,classified:items.reduce((a,it)=>{const t=classifyRecruitType(it);a[t]=(a[t]??0)+1;return a},{}),samples:items.slice(0,3).map(it=>({title:it.title,company:it.company,url:it.url,recruitType:classifyRecruitType(it),descriptionChars:it.description?.length??0,descChars:it.desc?.length??0})),candidates:cap.candidates}
if (site === 'boss' || site === '51job') {
  const it = items.find(it => !recruitType || classifyRecruitType(it) === recruitType)
  if (it?.url) {
    const detail = await fetchJdDetail({provider:resolveJdProvider({url:it.url}),url:it.detailUrl??it.url,dataDir,timeoutMs:14000})
    out.jd = {ok:detail.ok,title:it.title,url:it.url,descriptionChars:detail.description?.length??0,requirementsChars:detail.requirements?.length??0,error:detail.error,stage:detail.stage,excerpt:detail.description?.slice(0,140)}
  }
}
if (site==='xhs' && items[0]) {
  const body=await fetchXhsNoteBody(items[0],{dataDir})
  out.noteBody={ok:body.ok,title:items[0].title,chars:body.desc?.length??0,excerpt:body.desc?.slice(0,200),source:body.source,error:body.error}
}
if (!cap.ok || site === 'offershow') {
  const page = await capturePageText({dataDir,url:search.url,timeoutMs:9000})
  out.pageCheck = {ok:page.ok,url:page.url,title:page.title,excerpt:page.text?.slice(0,250),searchLinks:page.links?.filter(l=>/薪资|搜索|校招|查工资|实习/.test(l.text)).slice(0,12)}
}
fs.mkdirSync(path.join(dataDir,'verification'),{recursive:true})
const f = path.join(dataDir,'verification',`${site}-${Date.now()}.json`)
fs.writeFileSync(f,JSON.stringify(out,null,2),'utf8')
console.log(JSON.stringify(out,null,2))
console.log('LOCAL_RESULT='+f)
