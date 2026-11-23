import assert from'node:assert/strict'
import{it}from'node:test'
import{isUnder,normalisePath,resolveScopeRoots,buildWorkspaceGuard}from'../host/workspace-scope.js'
const ROOT='D:/career_os'
it('matches the root itself and real subdirectories, not siblings with a shared prefix',()=>{
 assert.equal(isUnder('D:\\career_os',[ROOT]),true)
 assert.equal(isUnder('D:\\career_os\\data',[ROOT]),true)
 assert.equal(isUnder('D:\\career_os_old',[ROOT]),false)
 assert.equal(isUnder('D:\\finance_ds',[ROOT]),false)
})
it('is case-insensitive on Windows paths and tolerant of a trailing slash',()=>{
 assert.equal(isUnder('d:/CAREER_OS/Data',[ROOT]),true)
 assert.equal(isUnder('D:/career_os/',[ROOT+'/']),true)
 assert.equal(normalisePath(' D:\\Career_OS\\ '),'d:/career_os')
})
it('defaults to the package root and honours configured roots',()=>{
 assert.deepEqual(resolveScopeRoots({},'D:/career_os'),['D:/career_os'])
 assert.deepEqual(resolveScopeRoots({workspaceRoots:['E:/a','E:/b']},'D:/career_os'),['E:/a','E:/b'])
})
it('keeps tools available when the session cwd is unknown',()=>{
 const {when,reason}=buildWorkspaceGuard({ctx:{get:()=>({get:()=>({header:{cwd:undefined}})})},config:{},packageRoot:ROOT})
 assert.equal(reason,'scoped')
 assert.equal(when({agent:{id:'s1'}}),true)
})
it('hides tools for a session whose cwd is another workspace',()=>{
 const {when}=buildWorkspaceGuard({ctx:{get:()=>({get:(id)=>({header:{cwd:id==='in'?'D:/career_os':'D:/finance_ds'}})})},config:{},packageRoot:ROOT})
 assert.equal(when({agent:{id:'in'}}),true)
 assert.equal(when({agent:{id:'out'}}),false)
})
it('fails open when the sessions service is absent or throws',()=>{
 assert.equal(buildWorkspaceGuard({ctx:{get:()=>undefined},config:{},packageRoot:ROOT}).when,undefined)
 const {when}=buildWorkspaceGuard({ctx:{get:()=>({get:()=>{throw new Error('boom')}})},config:{},packageRoot:ROOT})
 assert.equal(when({agent:{id:'s'}}),true)
})
it('can be switched off by config',()=>{
 const {when,reason}=buildWorkspaceGuard({ctx:{get:()=>({get:()=>({header:{cwd:'D:/x'}})})},config:{onlyInCareerWorkspace:false},packageRoot:ROOT})
 assert.equal(when,undefined)
 assert.equal(reason,'disabled-by-config')
})
