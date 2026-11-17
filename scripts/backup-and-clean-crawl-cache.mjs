// User-authorized temporary crawl-cache cleanup only. Never touches browser profile,
// business rows, resume files, or media referenced by knowledge/its revision history.
import fs from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=process.cwd(),data=path.resolve(root,'data')
if(data.toLowerCase()!=='d:\\career_os\\data')throw new Error('Unexpected workspace; refuse cleanup')
const stamp=new Date().toISOString().replace(/[:.]/g,'-')
const backup=path.join(data,'backups','v2-preflight-'+stamp)
fs.mkdirSync(backup,{recursive:true})
const db=new DatabaseSync(path.join(data,'career.db'))
const q=String(backup).replace(/'/g,"''")
const snapshot=path.join(backup,'career.db')
db.exec(`VACUUM INTO '${snapshot.replace(/'/g,"''")}'`)
const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
const counts={};for(const t of tables)counts[t.name]=Number(db.prepare(`SELECT count(*) AS n FROM "${t.name.replace(/"/g,'""')}"`).get().n)
const referenced=new Set()
function refs(v){if(!v)return;if(typeof v==='string'){if(/^[a-z]:[\\/]/i.test(v))referenced.add(path.resolve(v).toLowerCase())}else if(Array.isArray(v))v.forEach(refs);else if(typeof v==='object')Object.values(v).forEach(refs)}
for(const table of ['knowledge','knowledge_revision']){
 if(tables.some(t=>t.name===table))for(const r of db.prepare(`SELECT media FROM ${table}`).all()){try{refs(JSON.parse(r.media??'[]'))}catch{}}
}
const candidates=[]
function consider(file){const absolute=path.resolve(file);if(!absolute.startsWith(data+path.sep))throw new Error('Cleanup escapes data root');if(!fs.statSync(absolute).isFile())throw new Error('Only explicit files may be removed');if(!referenced.has(absolute.toLowerCase()))candidates.push(absolute)}
for(const folder of ['verification','ocr','knowledge-media']){
 const dir=path.join(data,folder);if(!fs.existsSync(dir))continue
 for(const ent of fs.readdirSync(dir,{withFileTypes:true}))if(ent.isFile())consider(path.join(dir,ent.name))
}
for(const filename of ['ocr-fixture.png','make-ocr-fixture.py','nowcoder-after-login.log','nowcoder-detail-result.log','nowcoder-detail-verified.log'])if(fs.existsSync(path.join(data,filename)))consider(path.join(data,filename))
const cacheBackup=path.join(backup,'temporary-cache');fs.mkdirSync(cacheBackup)
const manifest=[]
for(const file of candidates){const rel=path.relative(data,file),dest=path.join(cacheBackup,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');if(hash!==createHash('sha256').update(fs.readFileSync(dest)).digest('hex'))throw new Error('Backup hash mismatch');manifest.push({path:rel,bytes:bytes.length,sha256:hash})}
// Copy personal user documents for recovery; never read browser credentials.
for(const folder of ['resumes','tex'])if(fs.existsSync(path.join(data,folder)))fs.cpSync(path.join(data,folder),path.join(backup,'user-files',folder),{recursive:true})
execFileSync('git',['archive','--format=zip','--output='+path.join(backup,'source-HEAD.zip'),'HEAD'],{cwd:root,stdio:'ignore'})
fs.writeFileSync(path.join(backup,'schema.json'),JSON.stringify(tables,null,2))
fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),counts,temporaryCache:manifest,preservedReferenceFiles:referenced.size,scope:'only temporary crawl cache; browser-profile and business rows untouched'},null,2))
// Verify database recovery with an independent copy, not by replacing live data.
const restored=path.join(backup,'restore-verification.db');fs.copyFileSync(snapshot,restored)
const check=new DatabaseSync(restored,{readOnly:true})
if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Restored DB integrity check failed')
if(check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Restored DB foreign keys failed')
for(const [table,n]of Object.entries(counts)){const actual=Number(check.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g,'""')}"`).get().n);if(actual!==n)throw new Error('Restored count mismatch: '+table)}
check.close()
for(const file of candidates){const verified=path.resolve(file);if(!manifest.some(m=>path.resolve(data,m.path)===verified))throw new Error('Unverified delete target');fs.unlinkSync(verified)}
for(const [table,n]of Object.entries(counts)){const actual=Number(db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g,'""')}"`).get().n);if(actual!==n)throw new Error('Business table changed during cleanup: '+table)}
db.close()
console.log(JSON.stringify({ok:true,backup,removedFiles:manifest.length,removedBytes:manifest.reduce((n,m)=>n+m.bytes,0),preservedReferenceFiles:referenced.size,businessCountsUnchanged:true,restoreVerified:true,counts:Object.fromEntries(['job','company','resume_version','application','forum_post','knowledge'].map(k=>[k,counts[k]]))},null,2))
