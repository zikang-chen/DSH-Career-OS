import assert from 'node:assert/strict'
import {it} from 'node:test'
import {ResearchBudget,boundedResearch} from '../host/research-budget.js'
it('stops additional searches at the shared visit budget',async()=>{const b=new ResearchBudget({maxVisits:1});assert.equal(await b.visit('one',async()=>1),1);await assert.rejects(b.visit('two',async()=>2),/访问预算/);assert.equal(b.summary().visits,1)})
it('cancelled research never starts a new operation',async()=>{const c=new AbortController();c.abort();const b=new ResearchBudget({signal:c.signal});let called=false;await assert.rejects(b.visit('one',async()=>{called=true}),/取消/);assert.equal(called,false)})
it('dedupes concurrent identical readonly work and reuses short cache',async()=>{let n=0;const key='test-'+Date.now();const op=async()=>{n++;await new Promise(r=>setTimeout(r,5));return {ok:true,value:1}};await Promise.all([boundedResearch(key,op),boundedResearch(key,op)]);const cached=await boundedResearch(key,op);assert.equal(n,1);assert.equal(cached.cache.hit,true)})
