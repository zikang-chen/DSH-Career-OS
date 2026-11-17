import assert from'node:assert/strict'
import{it}from'node:test'
import{withJobListEvidence}from'../host/job-list-evidence.js'
it('hydrates 500 list entries with exactly two evidence queries, never full detail calls',()=>{let queries=0;const rows=Array.from({length:500},(_,i)=>({id:String(i)}));const repos={db:{all:(sql,ids)=>{queries++;assert.equal(ids.length,500);return sql.includes('job_source')?[{job_id:'0',source_type:'official_careers'}]:[]}},jobs:{getJob(){throw new Error('must not load full details')}}};const out=withJobListEvidence(repos,rows);assert.equal(queries,2);assert.equal(out[0].sources.length,1);assert.equal(out.length,500)})
