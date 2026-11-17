// 幂等补建统一索引：正文仍以业务表为准，知识库保存可回溯快照和整理状态。
export function syncKnowledgeIndex(repos){
 let indexed=0,failed=0
 // 合并旧索引平台别名产生的完全相同副本；有整理/OCR/正文差异时保留供人工处理。
 for(const group of repos.db.all("SELECT source_entity_type AS type,source_entity_id AS entity FROM knowledge WHERE source_entity_id IS NOT NULL GROUP BY source_entity_type,source_entity_id HAVING count(*)>1")) {
  const rows=repos.db.all('SELECT * FROM knowledge WHERE source_entity_type=? AND source_entity_id=? ORDER BY created_at,id',[group.type,group.entity]);const keep=rows[0]
  for(const row of rows.slice(1)) if(row.body===keep.body&&row.status==='inbox'&&!row.notes&&row.tags==='[]'&&row.media==='[]') repos.db.tx(()=>{repos.db.run('DELETE FROM knowledge_revision WHERE knowledge_id=?',[row.id]);repos.db.run('DELETE FROM knowledge WHERE id=?',[row.id])})
 }
 const put=input=>{try{repos.knowledge.upsert(input);indexed++}catch{failed++}}
 for(const j of repos.jobs.listJobs({limit:1000})) {
  const s=repos.db.get('SELECT * FROM job_source WHERE job_id=? ORDER BY retrieved_at DESC LIMIT 1',[j.id])
  let platform='job';try{const host=new URL(j.apply_url??s?.source_url).hostname;platform=host.includes('zhipin')?'boss':host.includes('51job')?'51job':s?.source_type==='official_careers'?'official':'job'}catch{}
  put({kind:'job',title:j.title,company:j.company_name,role:j.title,platform,url:j.apply_url,body:[j.description,j.requirements].filter(Boolean).join('\n\n'),completeness:j.description||j.requirements?'full':'summary',evidenceLevel:s?.source_type==='official_careers'?'A':'U',sourceEntityType:'job',sourceEntityId:j.id,publishedAt:j.published_at})
 }
 for(const p of repos.db.all('SELECT * FROM forum_post'))put({kind:'interview',title:p.title??'论坛资料',company:p.company_id?repos.db.get('SELECT name FROM company WHERE id=?',[p.company_id])?.name:null,platform:p.platform,url:p.url,body:p.content_excerpt??'',completeness:'summary',evidenceLevel:'C',sourceEntityType:'forum_post',sourceEntityId:p.id,publishedAt:p.published_at})
 for(const r of repos.db.all('SELECT * FROM research_report'))put({kind:'research',title:r.title,company:r.company_id?repos.db.get('SELECT name FROM company WHERE id=?',[r.company_id])?.name:null,platform:'research',body:r.body??'',completeness:'full',evidenceLevel:'U',sourceEntityType:'research_report',sourceEntityId:r.id,publishedAt:r.data_as_of})
 return {indexed,failed,note:'只补索引，不修改岗位/论坛原始业务数据；既有整理状态和OCR不重置。'}
}
