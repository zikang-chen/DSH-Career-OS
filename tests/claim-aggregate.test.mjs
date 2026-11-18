import assert from'node:assert/strict'
import{it}from'node:test'
import{aggregateClaims}from'../host/claim-aggregate.js'
const claim=(extra)=>({id:'c',category:'interview',claim:'常考SQL',stance:'neutral',evidence_level:'C',observed_year:2025,department:'搜索',first_hand:0,...extra})
it('splits claims by year and department instead of merging cohorts',()=>{const r=aggregateClaims([claim({id:'1',observed_year:2024,department:'搜索'}),claim({id:'2',observed_year:2026,department:'推荐'})]);const g=r.groups[0];assert.deepEqual(Object.keys(g.byYear),['2024','2026']);assert.deepEqual(Object.keys(g.byDepartment).sort(),['推荐','搜索']);assert.equal(r.coverage.withYear,2)})
it('flags opposite stances on the same claim as a conflict rather than a majority',()=>{const r=aggregateClaims([claim({id:'1',stance:'positive'}),claim({id:'2',stance:'negative'})]);assert.equal(r.groups[0].conflicts.length,1);assert.ok(r.caveats.some(c=>c.includes('冲突')))})
it('marks small samples as inadequate instead of a rule',()=>{const r=aggregateClaims([claim({id:'1'})]);assert.equal(r.groups[0].sampleAdequate,false);const big=aggregateClaims([claim({id:'1'}),claim({id:'2'}),claim({id:'3'})]);assert.equal(big.groups[0].sampleAdequate,true)})
it('counts unknown year and department honestly',()=>{const r=aggregateClaims([claim({id:'1',observed_year:null,department:''})]);assert.equal(r.coverage.withYear,0);assert.equal(r.groups[0].byYear['年份未知'],1);assert.equal(r.groups[0].byDepartment['部门未知'],1)})
