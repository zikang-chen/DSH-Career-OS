// 牛客公开讨论搜索：只从页面真实链接提取，不猜私有接口；详情按已知正文容器验证。
import {capturePageText,checkpoint,remainingTimeout} from './browser.js'
export function parseNowcoderLinks(links=[]) {
  const seen=new Set(),out=[]
  for(const link of links){
    let u;try{u=new URL(link.url)}catch{continue}
    if(!/(^|\.)nowcoder\.com$/.test(u.hostname)||!/^\/(?:discuss\/\d+|feed\/main\/detail\/[a-z0-9]+)\/?$/i.test(u.pathname))continue
    const title=String(link.text??'').trim();const key=u.origin+u.pathname
    if(title.length<5||title.length>150||seen.has(key))continue
    seen.add(key);out.push({platform:'nowcoder',title,url:key,desc:null,publishedAt:null,bodyStatus:'list-only'})
  }
  return out
}
export async function captureNowcoder(args,{config,repos,panel,budget,signal,deadlineAt,timeoutMs=40000,captureText=capturePageText}={}){
  signal ??= args.signal ?? budget?.signal
  deadlineAt=Math.min(deadlineAt??args.deadlineAt??Infinity,budget?.deadline??Infinity,Date.now()+(args.timeoutMs??timeoutMs))
  const options={signal,deadlineAt}
  const visit=(label,request)=>{checkpoint(options);return budget?budget.visit(label,()=>captureText({...request,signal,deadlineAt,timeoutMs:remainingTimeout(request.timeoutMs,options)})):captureText({...request,signal,deadlineAt,timeoutMs:remainingTimeout(request.timeoutMs,options)})}
  let limited=[],bodyFilled=0
  try {
  const keyword=String(args.keyword??'').trim().slice(0,120)
  if(!keyword)return {ok:false,stage:'validation',error:'牛客搜索需要keyword'}
  const url=`https://www.nowcoder.com/search?query=${encodeURIComponent(keyword)}&type=post`
  const page=await visit('nowcoder:list',{dataDir:config.dataDir,url,timeoutMs:16000})
   if(!page.ok&&['cancelled','deadline'].includes(page.stage))return page
  const blocked=/安全验证|请完成验证|访问受限|登录后查看/.test(page.text??'')
  const items=page.ok&&!blocked?parseNowcoderLinks(page.links):[]
  if(!items.length){repos?.monitor.recordSourceResult('social_platform',{ok:false,error:blocked?'牛客要求登录或人工验证':'未读取到讨论链接'});return {ok:false,stage:blocked?'login_required':'capture',error:blocked?'牛客要求登录或人工验证':'未读取到牛客讨论链接',page:{url:page.url,title:page.title}}}
  limited=items.slice(0,Math.max(1,Math.min(Number(args.limit)||10,50)))
  const failures=[]
  if(args.fillBody!==false){for(const it of limited.slice(0,Math.max(0,Math.min(Number(args.bodyLimit??2),5)))){
    const d=await visit('nowcoder:detail',{dataDir:config.dataDir,url:it.url,selectors:['.nc-slate-editor-content','.post-topic-des-main','.post-topic-des','.discuss-content','.feed-detail-content'],timeoutMs:12000})
    if(!d.ok&&['cancelled','deadline'].includes(d.stage))return {...d,preview:limited,bodyFilled}
    const body=d.sections?.map(s=>s.text.trim()).filter(s=>s.length>80).sort((a,b)=>a.length-b.length)[0]
    if(body&&!/登录后查看|安全验证|访问受限/.test(body)){it.desc=body.slice(0,20000);it.bodyStatus='partial';it.note='页面可见节选，可能含展开/付费截断；不承诺全文';bodyFilled++}
    else failures.push({title:it.title,error:'详情正文容器未确认；保留原链接，不将整页导航当面经'})
  }}
  let saved=0,duplicate=0
  if(args.dryRun===false){for(const it of limited){checkpoint(options);budget?.check();const r=repos.intel.addForumPost({platform:'nowcoder',title:it.title,url:it.url,content:[it.title,it.desc].filter(Boolean).join('\n\n'),accessMode:'browser_session'});repos.knowledge?.upsert({kind:'interview',title:it.title,company:args.company??null,role:args.role??null,platform:'nowcoder',url:it.url,body:it.desc??'',completeness:it.bodyStatus==='partial'?'partial':'summary',evidenceLevel:'C',sourceEntityType:'forum_post',sourceEntityId:r.id});r.duplicate?duplicate++:saved++}}
  repos?.monitor.recordSourceResult('social_platform',{ok:true,fetched:items.length,inserted:saved,dedupe:duplicate})
  panel?.publish({kind:'sources'})
  return {ok:true,site:'nowcoder',dryRun:args.dryRun!==false,found:items.length,bodyFilled,bodyFailures:failures,preview:limited,saved,duplicate,scope:'牛客当前搜索页的讨论/面经线索，非职位库；求面经/推广帖不自动当作真实面试经历'}
  } catch(error) { return {ok:false,stage:error.stage??(signal?.aborted?'cancelled':Date.now()>=deadlineAt?'deadline':'budget'),error:error.message,preview:limited,bodyFilled} }
}
