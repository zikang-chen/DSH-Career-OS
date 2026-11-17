// Job360 composes existing entities, never copies a second independent job truth.
import {assessJob360} from './assessment.js'
import {prepResumeForJob} from './workflows.js'
const DISPLAY={verified_open:'已核验开放',verified_closed:'已核验关闭',verified_upcoming:'尚未开始',stale:'信息已过期','open-unverified':'可能开放·待核验',unknown:'状态未知'}
export function assessJobDisplay(job,profile){const assessment=assessJob360({job,profile});return {statusDisplay:DISPLAY[assessment.evidence.statusAssessment]??'待核验',statusEvidenceLevel:assessment.evidence.verifiedOpen?'verified':'unverified',matchReliable:assessment.fit.reliable,assessment}}
export function buildJob360(repos,id){
 const job=repos.jobs.getJob(id);if(!job)return null
 const profile=repos.profile.getWithResume(),experiences=repos.profile.listExperiences()
 const related=repos.knowledge.list({company:job.company_name,limit:40}).items
 // Company text match is only a candidate; explicitly exclude other named companies.
 const knowledge=related.filter(k=>k.kind==='job' ? k.sourceEntityId===job.id : k.company===job.company_name)
 const company=job.company_id?repos.jobs.getCompany(job.company_id):null
 const units=job.company_id?repos.db.all('SELECT * FROM company_unit WHERE company_id=?',[job.company_id]):[]
 const industry=company?.industry_id?repos.intel.getIndustry(company.industry_id):null
 const resumePlan=prepResumeForJob({job,profile,experiences,documents:repos.profile.listDocuments({})})
 const assessment=assessJob360({job,profile,experiences,knowledge})
 const companyEvidence=job.sources.filter(s=>s.source_type==='official_careers').map(s=>({url:s.source_url,retrievedAt:s.retrieved_at}))
 return {job,assessment,statusLabel:DISPLAY[assessment.evidence.statusAssessment]??'待核验',relatedKnowledge:knowledge,
  job360:{company:company?{id:company.id,name:company.name,business:company.data?.business??null,careersUrl:company.careers_url??null,officialSourceCandidates:companyEvidence,industry,units,reports:company.reports??[]}:null,
   knowledge,resumePlan:{...resumePlan,selected:resumePlan.selection?.keep??[]},application:job.application,
   resumeVersions:repos.profile.listResumes().map(r=>({id:r.id,label:r.label,parseStatus:r.parse_status})),
   caveats:['关联公司不等于相同部门/年份；相关资料需逐条确认适用范围。','简历建议只选择已有事实；未确认素材不升级为已证实能力。'],
  }}
}
