// Batch minimal evidence for list/home projections; full getJob is reserved for one Job360 detail.
export function withJobListEvidence(repos,rows){
 if(!rows.length)return []
 const ids=rows.map(j=>j.id),marks=ids.map(()=>'?').join(','),sources=repos.db.all(`SELECT job_id,source_type,source_url,retrieved_at,confidence_level FROM job_source WHERE job_id IN (${marks})`,ids),history=repos.db.all(`SELECT job_id,status,source_type,source_url,evidence,verified_at FROM job_status_history WHERE job_id IN (${marks})`,ids)
 const bySources=new Map(),byHistory=new Map()
 for(const r of sources){if(!bySources.has(r.job_id))bySources.set(r.job_id,[]);bySources.get(r.job_id).push(r)}
 for(const r of history){if(!byHistory.has(r.job_id))byHistory.set(r.job_id,[]);byHistory.get(r.job_id).push(r)}
 return rows.map(j=>({...j,sources:bySources.get(j.id)??[],history:byHistory.get(j.id)??[]}))
}
