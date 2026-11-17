// Read-only business-quality audit; no resume text/cookies/tokens in report.
import {DatabaseSync}from'node:sqlite'
const db=new DatabaseSync('data/career.db',{readOnly:true})
const total=db.prepare('SELECT count(*) AS n FROM job WHERE archived=0').get().n
const metrics=db.prepare(`SELECT count(*) AS total,sum(status='OPEN') AS storedOpen,sum(length(trim(coalesce(description,'')))>0 AND length(trim(coalesce(requirements,'')))>0) AS textComplete,sum(apply_url IS NOT NULL AND trim(apply_url)<>'') AS hasApplyUrl,sum(status='OPEN' AND status_verified_at IS NULL) AS openWithoutTimestamp FROM job WHERE archived=0`).get()
const histories=db.prepare(`SELECT status,source_type,count(*) AS n,sum(length(trim(coalesce(evidence,'')))>0) AS withExcerpt FROM job_status_history GROUP BY status,source_type`).all()
const companies=db.prepare(`SELECT c.id,c.name,c.careers_url,count(j.id) AS jobs,(SELECT count(*) FROM job_source s JOIN job jj ON jj.id=s.job_id WHERE jj.company_id=c.id AND s.source_type='official_careers') AS officialSources FROM company c LEFT JOIN job j ON j.company_id=c.id GROUP BY c.id`).all()
console.log(JSON.stringify({metrics,denominator:total,historyEvidence:histories,companyLinkage:companies,notes:['storedOpen is a stored label, not a newly verified live opening','textComplete requires both nonempty text fields; does not prove current/official content']},null,2));db.close()
