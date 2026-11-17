// Today's priorities derived from existing records. User dispositions are append-only feedback events.
import {assessJobDisplay} from './job360.js'
import {parseJson} from './util.js'
import {withJobListEvidence} from './job-list-evidence.js'
const ACTIVE=new Set(['saved','researching','resume_todo','ready','applied','assessment','written_test','interview_1','interview_2','final','hr','offer'])
export function buildToday(repos,{now=new Date().toISOString()}={}){
 const profile=repos.profile.getWithResume(),all=repos.jobs.listJobs({limit:500}),apps=repos.applications.list({limit:500}),byJob=new Map(apps.filter(a=>ACTIVE.has(a.status)).map(a=>[a.job_id,a]))
 const todayLocal=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))
 const history=repos.db.all("SELECT subject_id,verdict,note,created_at FROM feedback WHERE subject_type='today_task' ORDER BY created_at DESC")
 const disposition=new Map();for(const h of history)if(!disposition.has(h.subject_id))disposition.set(h.subject_id,h)
 const priorities=[],deadlineMs=Date.parse(now)+7*86400000
 for(const job of all){if(!job.deadline)continue;const due=Date.parse(job.deadline+'T23:59:59+08:00');const app=byJob.get(job.id)
  if(due>=Date.parse(now)&&due<=deadlineMs&&(!app||['saved','researching','resume_todo','ready'].includes(app.status)))priorities.push({id:`deadline:${job.id}:${job.deadline}`,kind:'deadline',priority:'high',title:'申请截止临近',reason:'岗位记录中的截止日期在未来7天内，尚未记录正式投递；日期本身仍需来源核对。',company:job.company_name,jobTitle:job.title,jobId:job.id,dueAt:job.deadline,action:{label:'查看岗位与申请准备',tab:'radar',code:job.id}})
 }
 for(const a of apps)if(ACTIVE.has(a.status)&&a.next_action_at&&a.next_action_at.slice(0,10)<=todayLocal)priorities.push({id:`followup:${a.id}:${a.next_action_at}`,kind:'followup',priority:'high',title:a.next_action||'申请需要跟进',reason:'到达你设置的下一步日期，不代表招聘方已经回复。',company:a.company_name,jobTitle:a.job_title,jobId:a.job_id,applicationId:a.id,dueAt:a.next_action_at,action:{label:'查看申请',tab:'tracker',code:a.job_id}})
 const viewed=withJobListEvidence(repos,all).map(job=>({job,...assessJobDisplay(job,profile)}))
 for(const row of viewed.filter(r=>byJob.has(r.job.id)&&!r.assessment.evidence.textComplete).slice(0,3))priorities.push({id:`jd:${row.job.id}`,kind:'data_gap',priority:'normal',title:'收藏岗位缺少完整JD',reason:'职责或要求尚缺，暂不能形成可靠申请方案。',company:row.job.company_name,jobTitle:row.job.title,jobId:row.job.id,dueAt:null,action:{label:'补齐岗位资料',tab:'radar',code:row.job.id}})
 const visible=priorities.filter(p=>{const d=disposition.get(p.id);if(!d)return true;if(d.verdict==='done'||d.verdict==='ignore')return false;if(d.verdict==='snooze'){const n=parseJson(d.note,{});return !n.until||n.until<=now}return true}).sort((a,b)=>(a.priority==='high'?-1:1)-(b.priority==='high'?-1:1)||String(a.dueAt??'9999').localeCompare(String(b.dueAt??'9999'))).slice(0,5)
 const candidates=viewed.filter(r=>!['verified_closed'].includes(r.assessment.evidence.statusAssessment)&&!byJob.has(r.job.id))
 candidates.sort((a,b)=>Number(b.assessment.evidence.verifiedOpen)-Number(a.assessment.evidence.verifiedOpen)||Number(b.assessment.evidence.textComplete)-Number(a.assessment.evidence.textComplete)||(b.assessment.fit.score-a.assessment.fit.score))
 const recommendations=candidates.slice(0,5).map(r=>({id:r.job.id,company:r.job.company_name,title:r.job.title,location:r.job.location,recruitType:r.job.recruit_type,statusDisplay:r.statusDisplay,verifiedAt:r.assessment.evidence.latestObservation?.verifiedAt??null,fit:{score:r.assessment.fit.score,reliable:r.assessment.fit.reliable},reasons:r.assessment.decision.reasons.slice(0,2),gaps:r.assessment.unknowns.slice(0,2),deadline:r.job.deadline}))
 const groups=[['saved','已收藏'],['ready','准备申请'],['applied','已投递'],['assessment','测评/笔试'],['interview_1','面试'],['offer','Offer']]
 const pipeline=groups.map(([status,label])=>({status,label,count:apps.filter(a=>status==='assessment'?['assessment','written_test'].includes(a.status):status==='interview_1'?['interview_1','interview_2','final','hr'].includes(a.status):status==='ready'?['researching','resume_todo','ready'].includes(a.status):a.status===status).length}))
 return {profile:{headline:profile.headline??null,targetRoles:profile.target_roles??[],cities:profile.cities??[],gradYear:profile.grad_year,profileConfirmation:'填字段不等于资格已确认'},priorities:visible,recommendations,pipeline,changes:repos.monitor.listNotifications({limit:5}),health:{total:all.length,textComplete:viewed.filter(r=>r.assessment.evidence.textComplete).length,verifiedOpen:viewed.filter(r=>r.assessment.evidence.verifiedOpen).length,missingOfficialLink:viewed.filter(r=>!r.assessment.evidence.officialSource).length},coverage:{scope:'本地岗位与申请数据',loadedJobs:all.length,maxJobs:500,loadedApplications:apps.length,maxApplications:500},updatedAt:now}
}
export function updateTodayTask(repos,{id,action,until}){
 if(!id||!['done','snooze','ignore'].includes(action))throw new Error('需要任务id与done/snooze/ignore')
 const at=new Date().toISOString(),next=until??new Date(Date.now()+86400000).toISOString()
 if(action==='snooze'&&!Number.isFinite(Date.parse(next)))throw new Error('稍后时间无效')
 const uid=globalThis.crypto.randomUUID()
 repos.db.run('INSERT INTO feedback (id,subject_type,subject_id,verdict,note,created_at) VALUES (?,?,?,?,?,?)',[uid,'today_task',String(id),action,JSON.stringify({until:action==='snooze'?next:null}),at])
 return {ok:true,id,action,until:action==='snooze'?next:null}
}
