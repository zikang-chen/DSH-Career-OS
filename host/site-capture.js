// 工具与 HTTP 共用的站点采集用例；预览可以读JD但不写岗位/论坛/时间线。
import { capturePageJson, capturePageText } from './browser.js'
import { fetchJdDetail, resolveJdProvider } from './jd.js'
import {captureNowcoder} from './nowcoder.js'
import {processKnowledgeOcr} from './ocr.js'
import { classifyRecruitType, filterByRecruitType, getSiteProfile, normalizeRecruitType } from './sites.js'

const sourceForSite = (site) => ({boss:'job_board','51job':'job_board',xhs:'social_platform',offershow:'offershow'})[site]

/** 一组一张源卡片，组内每个平台单独登录，展示最近实际采集状态而不是猜Cookie。 */
export function sourceHealthRows(repos) {
  const latest = new Map()
  for (const r of repos.monitor.listRuns(200)) {
    if (r.kind === 'site_capture' && !latest.has(r.target)) latest.set(r.target,r)
  }
  const groups = {job_board:['boss','51job'],social_platform:['xhs','nowcoder'],offershow:['offershow']}
  return repos.monitor.listSources().map(s=>({...s,sites:(groups[s.connector]??[]).map(key=>{
    const p=getSiteProfile(key),r=latest.get(key)
    return {key,label:p.label,loginUrl:p.loginUrl,lastCheck:r?{status:r.status,at:r.finished_at,found:r.fetched,jdFilled:r.meta?.jdFilled??0,error:r.error}:null}
  })}))
}
function bounded(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new Error(`参数必须是 ${min}–${max} 的整数`)
  return n
}
function relevant(item, keyword) {
  const text = [item.company,item.title,item.desc].filter(Boolean).join(' ').toLowerCase()
  return String(keyword).trim().split(/\s+/).every(t=>text.includes(t.toLowerCase()))
}

export function isSubstantiveNoteText(value) {
  // 只有标签的图文笔记不能计为已取得完整面经；图片/视频内容尚未OCR。
  const body=String(value??'').replace(/#[^#\s]+/g,'').replace(/\s/g,'')
  return body.length>=40
}

export async function fetchXhsNoteBody(item, {dataDir,captureJson = capturePageJson,captureText = capturePageText} = {}) {
  if (!item?.id || !item.url) return {ok:false,error:'笔记缺少详情链接'}
  const parse=getSiteProfile('xhs').parse
  const cap=await captureJson({dataDir,url:item.url,patterns:['/feed'],prefer:'/feed',timeoutMs:10000,
    validateJson:json=>parse(json).some(n=>n.id===item.id && isSubstantiveNoteText(n.desc)),
  })
  if(cap.ok){const n=parse(cap.captured.json).find(n=>n.id===item.id);if(isSubstantiveNoteText(n?.desc))return {ok:true,desc:n.desc,publishedAt:n.publishedAt??item.publishedAt,media:n.media,source:'note-detail-json'}}
  const selectors=['#detail-desc','.note-content .desc']
  const page=await captureText({dataDir,url:item.url,selectors,timeoutMs:12000})
  const text=(page.sections??[]).filter(s=>selectors.includes(s.selector)).map(s=>s.text).sort((a,b)=>b.length-a.length)[0]
  const images=[...new Map((page.images??[]).filter(i=>i.url).map(i=>[i.url,i])).values()].map((image,i)=>({...image,index:i+1,ocrStatus:'pending'}))
  const media={images,type:item.media?.type??null,textStatus:'not-ocr-processed'}
  if(!page.ok || !isSubstantiveNoteText(text) || /登录后|安全验证|验证码|访问受限/.test(text??'')) return {ok:false,media,error:'笔记可能仅含标签或图片/视频，未取得可用的面经文字；不以标题或标签冒充正文'}
  return {ok:true,desc:text.slice(0,20000),media,source:'note-detail-dom'}
}

export async function captureSite(args = {}, {config,repos,panel,logger,captureJson = capturePageJson,fetchDetail = fetchJdDetail,fetchNoteBody = fetchXhsNoteBody} = {}) {
  if(args.site==='nowcoder') return captureNowcoder(args,{config,repos,panel})
  const profile = getSiteProfile(args.site)
  if (!profile) return {ok:false,stage:'validation',error:'未知站点（xhs/boss/51job/offershow）'}
  let wantType,limit,jdLimit,bodyLimit,timeoutMs,plan,targetUrl
  const keyword = String(args.keyword ?? '').trim().slice(0,120)
  try {
    wantType = normalizeRecruitType(args.recruitType)
    if (wantType && profile.kind !== 'job') throw new Error('招聘类型筛选仅用于BOSS/51job岗位，不适用于笔记或校招计划')
    limit = bounded(args.limit,30,1,200)
    jdLimit = bounded(args.fillJdLimit,3,0,20)
    bodyLimit = bounded(args.bodyLimit,2,0,10)
    timeoutMs = bounded(args.timeoutMs,20000,4000,60000)
    if (!keyword && !args.url) throw new Error('需要 keyword 或 url')
    plan = profile.searchPlan ? profile.searchPlan({keyword,city:args.city,recruitType:wantType}) : {url:profile.searchUrl({keyword,city:args.city}),nativeRecruitTypeFilter:false}
    targetUrl = args.url || plan.url
    const target = new URL(targetUrl)
    const host = new URL(profile.loginUrl).hostname.replace(/^www\./,'')
    if (target.protocol !== 'https:' || !(target.hostname === host || target.hostname.endsWith('.'+host))) throw new Error('站点URL必须是该平台的HTTPS网页')
  } catch (err) { return {ok:false,stage:'validation',error:String(err.message)} }

  const runId = repos?.monitor.startRun('site_capture',profile.key)
  const finish = (result,counts={}) => {
    const meta = {site:profile.key,keyword,recruitType:wantType,stage:result.stage??'done',dryRun:args.dryRun!==false,jdFilled:result.jdFilled??0,jdFailed:result.jdFailures?.length??0,page:result.page??null}
    const sourceOk = result.ok || result.stage === 'no_match'
    repos?.monitor.finishRun(runId,{status:sourceOk ? 'ok':'error',fetched:result.found??0,inserted:counts.inserted??0,duplicates:counts.duplicates??0,error:result.error,meta})
    // 预览也算抓取，但新增/去重只按实际落库数统计；绝不把“启用”等同登录成功。
    repos?.monitor.recordSourceResult(sourceForSite(profile.key),{ok:sourceOk,error:sourceOk?null:result.error,fetched:result.found??0,inserted:counts.inserted??0,dedupe:counts.duplicates??0})
    panel?.publish({kind:'sources'})
    return {site:profile.key,checkedAt:new Date().toISOString(),...result}
  }
  try {
    const cap = await captureJson({dataDir:config.dataDir,url:targetUrl,matchUrl:args.useOpenTab===true?targetUrl:undefined,
      patterns:profile.patterns,prefer:profile.prefer,timeoutMs,logger,
      search:profile.searchUi&&keyword?{selector:profile.searchUi,keyword:plan.searchKeyword??keyword}:undefined,
      validateJson:(json,responseUrl)=>{const rows=profile.parse(json);return rows.length>0 && (!profile.prefer || new RegExp(profile.prefer,'i').test(responseUrl)) && (profile.key!=='offershow'||!keyword||rows.some(it=>relevant(it,keyword)))},
    })
    if (!cap.ok) return finish({ok:false,stage:cap.stage??'capture',error:cap.error,page:cap.page,candidates:cap.candidates??[],loginUrl:profile.loginUrl,next:'在设置→数据源打开对应站点；若有验证请人工完成。登录成功后可再次搜索。'})
    const items = profile.parse(cap.captured.json)
    const classified = {campus:0,social:0,intern:0,unknown:0}
    for (const it of items) classified[classifyRecruitType(it)]++
    // 未核实的关键字路由（如OfferShow首页）只能做可解释的页内过滤，不能冒充全站搜索。
    const related = keyword && (profile.kind==='job' || profile.keywordSearchVerified===false) ? items.filter(it=>relevant(it,keyword)) : items
    const filtered = filterByRecruitType(related,wantType)
    const limited = filtered.slice(0,limit)
    const base = {ok:true,dryRun:args.dryRun!==false,found:items.length,matched:filtered.length,classified,recruitType:wantType,
      sourceUrl:cap.captured.url,page:cap.page,search:{keyword,nativeRecruitTypeFilter:plan.nativeRecruitTypeFilter===true,scope:profile.keywordSearchVerified===false?'仅当前页面返回数据的本地相关性过滤，不是全站搜索':'站点关键词搜索 + 逐条类型核验',keywordSearchVerified:profile.keywordSearchVerified!==false},
      warnings:['仅当前返回页，未遍历全部分页；未知招聘类型不会混入校招/社招/实习结果。'],
    }
    if (!limited.length && items.length) {
      return finish({...base,ok:false,stage:'no_match',error:`本页返回 ${items.length} 条，但没有可确认符合关键词/招聘类型的结果；不是全站无岗位。`,preview:[]})
    }
    let jdFilled = 0
    const jdFailures = []
    if (profile.kind === 'job' && args.fillJd !== false) {
      for (const it of limited.slice(0,jdLimit)) {
        const detailUrl = it.detailUrl ?? it.url
        const provider = resolveJdProvider({url:detailUrl})
        if (!detailUrl || !provider) { jdFailures.push({title:it.title,error:'缺少有效详情链接/提供方'});continue }
        const detail = await fetchDetail({provider,url:detailUrl,jobCode:it.jobCode,dataDir:config.dataDir,timeoutMs:14000})
        if (!detail.ok) {jdFailures.push({title:it.title,url:it.url,error:detail.error});continue}
        it.description = detail.description??it.description
        it.requirements = detail.requirements??it.requirements
        it.jdSourceUrl = it.url
        it.jdRetrievedAt = new Date().toISOString()
        jdFilled++
      }
    }
    if (profile.key==='xhs' && args.fillBody!==false) {
      let bodyFilled=0
      const bodyFailures=[]
      for(const it of limited.slice(0,bodyLimit)) {
        const body=await fetchNoteBody(it,{dataDir:config.dataDir})
        if(body.ok){it.desc=body.desc;it.publishedAt=body.publishedAt??it.publishedAt;if(body.media)it.media=body.media;it.bodyStatus='detail';bodyFilled++}
        else {if(body.media)it.media=body.media;it.bodyStatus='list-only';bodyFailures.push({title:it.title,error:body.error})}
      }
      base.bodyFilled=bodyFilled
      base.bodyFailures=bodyFailures
      base.imagesPending=limited.reduce((n,it)=>n+(it.media?.images?.length??0),0)
      if(base.imagesPending) base.warnings.push(`${base.imagesPending} 张图片尚未OCR；文字正文已取得也不代表图片中的面经已读完。`)
    }
    base.jdFilled=jdFilled
    base.jdFailures=jdFailures
    if (jdFailures.length) base.warnings.push(`${jdFailures.length} 条JD未取回，不计入JD成功数；详情错误不会当作正文保存。`)
    base.preview=limited.slice(0,20).map(it=>({...it,recruitType:classifyRecruitType(it)}))
    if (args.dryRun !== false) return finish({...base,next:'当前是预览，未写岗位/笔记/时间线；确认后 dryRun=false 写入。'})
    if (!repos) throw new Error('缺少数据仓库，无法入库')
    if (profile.kind === 'job') {
      const postings = limited.map(it=>({company:it.company,title:it.title,location:it.location,salaryText:it.salaryText,jobCode:it.jobCode,url:it.url,applyUrl:it.url,
        recruitType:classifyRecruitType(it)==='unknown'?null:classifyRecruitType(it),description:it.description,requirements:it.requirements,publishedAt:it.publishedAt,
        notes:`来源：${profile.label}；学历：${it.degree??'未知'}；经验：${it.experience??'未知'}`,
      }))
      const imported=repos.jobs.importPostings(postings,{pageUrl:cap.page?.url??targetUrl,official:false,sourceName:`${profile.label}（浏览器采集，未核验）`})
      for(const id of [...imported.created,...imported.merged]) {
        const j=repos.jobs.getJob(id)
        repos.knowledge?.upsert({kind:'job',title:j.title,company:j.company_name,role:j.title,platform:profile.key,url:j.apply_url,publishedAt:j.published_at,body:[j.description,j.requirements].filter(Boolean).join('\n\n'),completeness:j.description||j.requirements?'full':'summary',evidenceLevel:'C',sourceEntityType:'job',sourceEntityId:id})
      }
      panel?.publish({kind:'jobs'})
      return finish({...base,created:imported.created.length,merged:imported.merged.length,jobIds:[...imported.created,...imported.merged],failed:imported.failed,ok:!imported.failed.length,next:'岗位已入库，第三方来源仍为UNVERIFIED；JD失败项目已单列。'},{inserted:imported.created.length,duplicates:imported.merged.length})
    }
    if (profile.kind === 'plan') {
      const plans=limited.filter(it=>it.startsAt)
      let addedEvents=0,duplicate=0
      for (const it of limited) repos.knowledge?.upsert({kind:it.salary?'salary':'announcement',title:it.title,company:it.company,platform:'offershow',url:it.url,publishedAt:it.publishedAt,body:it.salary??[it.title,it.city,it.year,it.startsAt,it.endsAt].filter(Boolean).join('\n'),completeness:'summary',evidenceLevel:'C'})
      for (const it of plans) {
        // 精确查重，不依赖列表上限；同一次请求内也是幂等的。
        const exists=repos.db.get('SELECT id FROM recruit_event WHERE title = ? AND starts_at = ? AND source_url IS ?',[it.title,it.startsAt,it.url??null])
        if (exists) {duplicate++;continue}
        repos.intel.addEvent({title:it.title,startsAt:it.startsAt,endsAt:it.endsAt,company:it.company,sourceUrl:it.url,source:'third_party',evidenceLevel:'C',stage:'apply_open',season:/春/.test(it.title)?'spring_campus':/秋/.test(it.title)?'autumn_campus':'other',note:'OfferShow转载校招计划；未核实批次不推断为秋招'})
        addedEvents++
      }
      return finish({...base,addedEvents,duplicate,skipped:limited.length-plans.length,next:'有日期的转载校招计划已入时间线；薪资与计划不会混为一类。'},{inserted:addedEvents,duplicates:duplicate})
    }
    let saved=0,duplicate=0,ocrProcessed=0
    const ocrFailures=[]
    for (const it of limited) {
      const content=[it.title,it.desc].filter(Boolean).join('\n\n')
      if (!content) continue
      const post=repos.intel.addForumPost({platform:'xiaohongshu',content,url:it.url,title:it.title,author:it.author,publishedAt:it.publishedAt,accessMode:'browser_session'})
      const knowledgeItem=repos.knowledge?.upsert({kind:'interview',title:it.title,company:args.company??null,role:args.role??null,platform:'xiaohongshu',url:it.url,publishedAt:it.publishedAt,body:it.desc??'',completeness:it.bodyStatus==='detail'?'full':'summary',evidenceLevel:'C',media:(it.media?.images??[]).map(image=>({...image,ocrStatus:'pending'})),sourceEntityType:'forum_post',sourceEntityId:post.id})
      if(args.autoOcr===true && knowledgeItem) for(let imageIndex=0;imageIndex<knowledgeItem.media.length && ocrProcessed<5;imageIndex++){
        if(knowledgeItem.media[imageIndex].ocrStatus==='reviewed')continue
        const result=await processKnowledgeOcr({id:knowledgeItem.id,index:imageIndex+1},{repos,config})
        ocrProcessed++
        if(!result.ok)ocrFailures.push({title:it.title,index:imageIndex+1,error:result.image?.error})
      }
      post.duplicate?duplicate++:saved++
    }
    return finish({...base,saved,duplicate,ocrProcessed,ocrFailures,next:'笔记已入论坛情报；列表摘要不等于完整面经正文。'},{inserted:saved,duplicates:duplicate})
  } catch (err) {return finish({ok:false,stage:'error',error:String(err.message)})}
}
