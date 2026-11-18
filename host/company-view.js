// Company 360 composition. Reuses job/company/industry facts; never silently rewrites the careers entry.
import {assessJobDisplay} from './job360.js'
import {withJobListEvidence} from './job-list-evidence.js'

const originOf = (value) => { try { return new URL(value).origin } catch { return null } }

export function buildCompanyView(repos, id, profile) {
  const company = repos.jobs.getCompany(id)
  if (!company) return null
  const sourceUrls = repos.db.all(`SELECT s.source_url FROM job_source s JOIN job j ON j.id = s.job_id
    WHERE j.company_id = ? AND s.source_type = 'official_careers' AND s.source_url IS NOT NULL LIMIT 50`, [company.id])
  const origins = [...new Set(sourceUrls.map((row) => originOf(row.source_url)).filter(Boolean))]
  const jobs = withJobListEvidence(repos, company.jobs).map((j) => {
    const display = assessJobDisplay(j, profile)
    return { id: j.id, title: j.title, location: j.location, deadline: j.deadline, applyUrl: j.apply_url, status: j.status,
      statusDisplay: display.statusDisplay, statusEvidenceLevel: display.statusEvidenceLevel, matchReliable: display.matchReliable }
  })
  const units = repos.db.all('SELECT name, business, strategic_role FROM company_unit WHERE company_id = ?', [company.id])
  const industry = company.industry_id ? repos.intel.getIndustry(company.industry_id) : null
  return {
    ok: true,
    company,
    jobs,
    diagnosis: {
      careersEntryMissing: !company.careers_url,
      officialSourceOrigins: origins,
      candidateCareersUrl: !company.careers_url && origins.length === 1 ? origins[0] : null,
      note: !company.careers_url && origins.length
        ? '岗位已有官方来源，但公司档案没有登记招聘入口。可确认采用该来源后启用监控；不会自动覆盖。'
        : null,
    },
    reports: company.reports ?? [],
    units,
    industry: industry ? { id: industry.id, name: industry.name } : null,
  }
}
