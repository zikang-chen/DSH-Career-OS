// HTTP API for the dashboard. One prefix route, internal dispatch.
//
// Security posture: the panel is same-origin with the DSH web app, so requests are
// checked against cross-site browser behaviour, and destructive operations require a
// prepared token. Nothing here can submit an application or send mail.
import fs from 'node:fs'
import path from 'node:path'
import { APPLICATION_LABEL, APPLICATION_STATUSES, JOB_STATUSES, MATCH_BANDS, RECRUIT_LABEL, STATUS_LABEL } from './domain.js'
import { crawlListing, postingToJob } from './crawl.js'
import { ATS_SPECS } from './ats.js'
import { buildRetrievalGuide } from './guide.js'
import { installPdfLibs, runtimeHealth } from './runtime.js'
import { compileTex, detectEngines, renderResumeTex, renderResumeText } from './latex.js'
import { KIND_LABEL, planTailor, sectionsFromSelection } from './tailor.js'
import { DOC_LABEL, proposeDocument } from './documents.js'
import { buildApplyCard, renderApplyCardText } from './applycard.js'
import { checkResumeQuality } from './quality.js'
import { buildInterviewPlan } from './interview.js'
import { SITE_PROFILES, getSiteProfile, loginUrlForConnector } from './sites.js'
import { captureSite, sourceHealthRows } from './site-capture.js'
import {processKnowledgeOcr,ocrStatus} from './ocr.js'
import {syncKnowledgeIndex} from './knowledge-sync.js'
import {assessJob360} from './assessment.js'
import {buildJob360,assessJobDisplay} from './job360.js'
import {buildToday,updateTodayTask} from './today.js'
import {createResearchTasks} from './research-tasks.js'
import {withJobListEvidence} from './job-list-evidence.js'
import {buildCompanyView} from './company-view.js'
import {buildIndustryResearchPlan, collectIndustrySnippets, renderIndustryResearchNote} from './industry-research.js'
import {buildApplicationCalendar} from './application-calendar.js'
import {compareJobs} from './job-compare.js'
import { capturePageJson, openForLogin } from './browser.js'
import { describeJsonShape } from './curl.js'
import { buildBrief, buildPlan } from './plan.js'
import { parsePastedJob } from './sources.js'
import { sha1ish } from './util.js'
import { nowIso, parseJson, str } from './util.js'

export const API_PREFIX = '/plugins/dsh-career/api'

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 2 * 1024 * 1024) throw new HttpError('请求体超过 2MB', 413)
    chunks.push(Buffer.from(chunk))
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new HttpError('请求体必须是 JSON 对象')
  }
}

/** Reject cross-site browser requests while still allowing local tools and curl. */
function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError('跨站请求被拒绝', 403)
  const origin = req.headers.origin
  if (origin) {
    try {
      const originHost = new URL(origin).host
      if (originHost !== req.headers.host) throw new HttpError('来源不匹配', 403)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError('无效的 Origin', 403)
    }
  }
}

export function registerRoutes({ webServer, repos, monitor, panel, exporter, config, logger, search, clientHealth, webService, db }) {
  const researchTasks=createResearchTasks({repos,config,panel,logger})
  const routes = []
  const route = (method, pattern, handler) => {
    const keys = []
    const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k)
      return '([^/]+)'
    })}$`)
    routes.push({ method, regex, keys, handler })
  }

  const bootstrap = () => {
    const profile = repos.profile.get()
    const active = repos.profile.activeResume()
    return {
      ok: true,
      now: nowIso(),
      status: {
        db: repos.db.info(),
        dataDir: config.dataDir,
        panelClients: panel.count,
        scheduleEnabled: config.scheduleEnabled === true,
        client: typeof clientHealth === 'function' ? clientHealth() : null,
      },
      profile,
      completeness: repos.profile.completeness(),
      activeResume: active ? { id: active.id, label: active.label, parseStatus: active.parse_status, chars: (active.raw_text ?? '').length, notes: active.parse_notes } : null,
      resumes: repos.profile.listResumes(),
      skills: repos.profile.listSkills(),
      digest: monitor.buildDigest(),
      today: buildToday(repos),
      board: repos.applications.board(),
      sources: sourceHealthRows(repos),
      rules: repos.monitor.listRules(),
      runs: repos.monitor.listRuns(15),
      notifications: repos.monitor.listNotifications({ limit: 30 }),
      feedback: repos.monitor.feedbackSummary(),
      labels: {
        status: STATUS_LABEL,
        application: APPLICATION_LABEL,
        bands: MATCH_BANDS,
        jobStatuses: JOB_STATUSES,
      },
      focus: panel.lastNavigate,
    }
  }

  // ── read ───────────────────────────────────────────────────────────────────
  route('GET', '/bootstrap', () => bootstrap())
  route('GET', '/today', () => ({ok:true,today:buildToday(repos)}))
  route('POST', '/today/task', ({body}) => {const result=updateTodayTask(repos,body);panel.publish({kind:'today'});return result})

  route('GET', '/jobs', ({ query }) => {
    const profile = repos.profile.getWithResume()
    const page = repos.jobs.queryPage({
      query: query.get('query') ?? undefined,
      status: query.get('status') ? query.get('status').split(',') : undefined,
      company: query.get('company') ?? undefined,
      location: query.get('location') ?? undefined,
      internshipType: query.get('type') ? query.get('type').split(',') : undefined,
      recruitType: query.get('recruitType') ? query.get('recruitType').split(',') : undefined,
      jdComplete: query.has('jdComplete') ? query.get('jdComplete') === 'true' : undefined,
      remoteType: query.get('remoteType') ? query.get('remoteType').split(',') : undefined,
      gradYear:query.get('gradYear')||undefined,daysPerWeekMax:query.get('daysPerWeekMax')||undefined,
      skill: query.get('skill') ?? undefined,
      minScore: query.get('minScore') ?? undefined,
      deadlineBefore: query.get('deadlineBefore') ?? undefined,
      limit: Number(query.get('limit') ?? 100),
      offset: Number(query.get('offset') ?? 0),
    })
    const rows=withJobListEvidence(repos,page.items)
    return {
      ok: true,
      total:page.total,limit:page.limit,offset:page.offset,
      count: rows.length,
      scope: '仅本地已入库岗位；未访问第三方招聘平台',
      jobs: rows.map((j) => ({
        ...assessJobDisplay(j,profile),
        id: j.id, company: j.company_name, companyId: j.company_id, title: j.title,
        location: j.location, department: j.department, internshipType: j.internship_type,
        internshipLabel: j.internship_type, status: j.status, statusLabel: STATUS_LABEL[j.status] ?? j.status,
        statusVerifiedAt: j.status_verified_at, deadline: j.deadline, matchScore: j.match_score,
        skills: j.skills, remoteType: j.remote_type, updatedAt: j.updated_at,
        salaryText:j.salary_text,recruitType:j.recruit_type,description:j.description,requirements:j.requirements,
        gradeLimit:j.grade_limit,daysPerWeek:j.days_per_week,duration:j.duration,applyUrl:j.apply_url,
        sources:repos.db.all('SELECT source_type,source_name,source_url,retrieved_at FROM job_source WHERE job_id=? ORDER BY retrieved_at DESC LIMIT 3',[j.id]),
        application:repos.db.get('SELECT id,status FROM application WHERE job_id=? AND archived=0 ORDER BY created_at DESC LIMIT 1',[j.id])??null,
      })),
    }
  })

  route('GET', '/jobs/compare', ({ query }) => compareJobs(repos, { ids: (query.get('ids') ?? '').split(','), profile: repos.profile.getWithResume() }))

  route('GET', '/job', ({ query }) => {
    const id = query.get('id')
    if (!id) throw new HttpError('缺少 id')
    const job = repos.jobs.getJob(id)
    if (!job) throw new HttpError('岗位不存在', 404)
    const view=buildJob360(repos,id)
    view.job.statusDisplay=view.statusLabel
    return {ok:true,...view}
  })

  route('GET', '/resume/quality', ({ query }) => {
    const job = query.get('jobId') ? repos.jobs.getJob(String(query.get('jobId'))) : null
    return {
      ok: true,
      ...checkResumeQuality({
        profile: repos.profile.get(),
        experiences: repos.profile.listExperiences(),
        documents: repos.profile.listDocuments({}),
        job,
      }),
      targetJob: job ? { id: job.id, company: job.company_name, title: job.title } : null,
    }
  })

  route('GET', '/resumes', () => ({ ok: true, resumes: repos.profile.listResumes(), active: repos.profile.activeResume()?.id ?? null }))

  route('GET', '/applications/calendar', ({ query }) => buildApplicationCalendar({
    applications: repos.applications.list({ limit: 500 }),
    days: query.get('days'),
  }))

  route('GET', '/applications', ({ query }) => ({
    ok: true,
    applications: repos.applications.list({
      status: query.get('status') ? query.get('status').split(',') : undefined,
      company: query.get('company') ?? undefined,
      query: query.get('q') ?? undefined,
      recruitType: query.get('type') ? query.get('type').split(',') : undefined,
      sort: query.get('sort') ?? undefined,
      limit: Number(query.get('limit') ?? 500),
    }),
    followUps: repos.applications.followUps(),
    stats: repos.applications.stats(),
    labels: APPLICATION_LABEL,
    recruitLabels: RECRUIT_LABEL,
  }))

  route('GET', '/applications/export', ({ query, res }) => {
    const rows = repos.applications.list({
      status: query.get('status') ? query.get('status').split(',') : undefined,
      company: query.get('company') ?? undefined,
      query: query.get('q') ?? undefined,
      limit: 5000,
      includeArchived: true,
    })
    const csv = repos.applications.toCsv(rows)
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="careeros-applications-${nowIso().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    })
    res.end(csv)
    return 'sent'
  })

  route('GET', '/companies', ({ query }) => ({ ok: true, companies: repos.jobs.listCompanies({ query: query.get('query') ?? undefined }) }))

  route('GET', '/company', ({ query }) => {
    const id = query.get('id') ?? repos.jobs.resolveCompany(query.get('name') ?? '', false)?.id
    const view = buildCompanyView(repos, id, repos.profile.getWithResume())
    if (!view) throw new HttpError('公司不存在', 404)
    return view
  })

  route('GET', '/industries', () => ({ ok: true, industries: repos.intel.listIndustries() }))

  route('GET', '/industry', ({ query }) => {
    const industry = repos.intel.getIndustry(query.get('id'))
    if (!industry) throw new HttpError('行业不存在', 404)
    return { ok: true, industry }
  })

  // Bounded industry research: a plan, then at most 3 public searches saved as sourced leads.
  route('GET', '/industry/plan', ({ query }) => {
    const industry = repos.intel.getIndustry(query.get('id'))
    if (!industry) throw new HttpError('行业不存在', 404)
    const companies = repos.db.all('SELECT id, name FROM company WHERE industry_id = ? LIMIT 20', [industry.id])
    const jobs = companies.length
      ? repos.db.all(`SELECT title, skills FROM job WHERE company_id IN (${companies.map(() => '?').join(',')}) LIMIT 100`, companies.map((c) => c.id))
      : []
    return buildIndustryResearchPlan({ industry, companies, jobs: jobs.map((j) => ({ ...j, skills: parseJson(j.skills, []) })) })
  })

  route('POST', '/industry/research', async ({ body }) => {
    const industry = repos.intel.getIndustry(String(body.id))
    if (!industry) throw new HttpError('行业不存在', 404)
    const companies = repos.db.all('SELECT id, name FROM company WHERE industry_id = ? LIMIT 20', [industry.id])
    const plan = buildIndustryResearchPlan({ industry, companies, jobs: [] })
    const collected = await collectIndustrySnippets({ name: industry.name, queries: body.queries ?? plan.queries, search, maxQueries: body.maxQueries })
    if (collected.ok === false && !collected.resultCount) return { ok: false, error: collected.error ?? '未检索到可用结果', collected }
    const report = repos.intel.saveReport({
      kind: 'industry', industryId: industry.id, title: `${industry.name} · 公开检索线索`,
      body: renderIndustryResearchNote({ name: industry.name, collected }),
      sources: collected.queries.flatMap((g) => g.sources.map((s) => s.url)).filter(Boolean).slice(0, 30),
      dataAsOf: new Date().toISOString().slice(0, 10),
    })
    panel.publish({ kind: 'reports', id: report.id })
    return { ok: true, report, collected, note: '已保存检索线索（含来源与日期）；这些是待核实线索，不是行业结论。' }
  })

  route('GET', '/reports', ({ query }) => ({ ok: true, reports: repos.intel.listReports({ kind: query.get('kind') ?? undefined, companyId: query.get('companyId') ?? undefined, industryId: query.get('industryId') ?? undefined }) }))

  route('GET', '/report', ({ query }) => {
    const report = repos.intel.getReport(query.get('id'))
    if (!report) throw new HttpError('报告不存在', 404)
    return { ok: true, report }
  })

  route('GET', '/social', ({ query }) => {
    const companyId = query.get('companyId') ?? undefined
    const posts = repos.db.all('SELECT * FROM forum_post WHERE (? IS NULL OR company_id = ?) ORDER BY retrieved_at DESC LIMIT 100', [companyId, companyId])
    return {
      ok: true,
      posts,
      claims: repos.intel.claimsFor({ companyId }),
      interviews: repos.intel.listInterviews({ companyId, limit: 50 }),
      accessNote: '小红书/脉脉/牛客等需登录且禁止自动化采集；此处内容全部来自用户手动粘贴或合法导出。',
    }
  })

  route('GET', '/bar', ({ query }) => ({ ok: true, ...repos.intel.barFor({ companyId: query.get('companyId') ?? undefined, company: query.get('company') ?? undefined, jobId: query.get('jobId') ?? undefined }) }))

  route('GET', '/interview', ({ query }) => ({
    ok: true,
    interviews: repos.intel.listInterviews({ jobId: query.get('jobId') ?? undefined, companyId: query.get('companyId') ?? undefined }),
  }))

  route('POST', '/interview/from-jd', async ({ body }) => {
    let jdText = str(body.jd, 20000)
    let job = null
    let companyName = str(body.company, 200) ?? null
    if (!jdText && body.jobId) {
      job = repos.jobs.getJob(String(body.jobId))
      if (job) {
        jdText = [job.description, job.requirements].filter(Boolean).join('\n')
        companyName = companyName ?? job.company_name
      }
    }
    const real = body.jobId ? repos.intel.listInterviews({ jobId: job?.id, companyId: job?.company_id, limit: 50 }) : []
    return buildInterviewPlan({
      jdText,
      title: str(body.title, 200) ?? job?.title ?? null,
      company: companyName,
      realExperiences: real,
      research: Array.isArray(body.research) ? body.research : [],
    })
  })

  route('GET', '/knowledge', ({query}) => ({ok:true,...repos.knowledge.list({query:query.get('query')||undefined,kind:query.get('kind')||undefined,company:query.get('company')||undefined,platform:query.get('platform')||undefined,status:query.get('status')||undefined,offset:Number(query.get('offset')||0),limit:Number(query.get('limit')||20)}),stats:repos.knowledge.stats()}))
  route('POST', '/knowledge/sync', () => ({ok:true,...syncKnowledgeIndex(repos)}))
  route('GET', '/knowledge/item', ({query}) => {const item=repos.knowledge.get(query.get('id'));if(!item)throw new HttpError('资料不存在',404);return {ok:true,item}})
  route('POST', '/knowledge/update', ({body}) => ({ok:true,item:repos.knowledge.update(String(body.id),Object.fromEntries(Object.entries(body).filter(([k])=>k!=='id')))}))
  route('GET', '/knowledge/ocr/status', () => ocrStatus({dataDir:config.dataDir}))
  route('POST', '/knowledge/ocr', ({body}) => processKnowledgeOcr(body,{repos,config}))

  route('GET', '/sites', () => ({ ok: true, sites: Object.values(SITE_PROFILES).map((s) => ({ key: s.key, label: s.label, kind: s.kind, loginUrl: s.loginUrl, note: s.note })) }))

  // 数据源设置里「双击/点登录」：打开专用浏览器登录页，登录态持久化在 data/browser-profile
  route('POST', '/sources/login', async ({ body }) => {
    const connector = str(body.connector, 40)
    const url = str(body.url, 2000) ?? loginUrlForConnector(connector) ?? (getSiteProfile(connector)?.loginUrl) ?? null
    if (!url) throw new HttpError('这个数据源没有可登录的网页入口（或尚未登记）', 400)
    const result = await openForLogin({ dataDir: config.dataDir, url, logger })
    return { ok: result.ok, connector, url, ...result, note: result.ok ? `已打开 ${url}。登录资料保存在本机专用浏览器，重启会保留；是否仍有效由站点决定，失效时请重新登录。` : result.error }
  })

  route('POST', '/site/capture', ({ body }) => captureSite(body, { config, repos, panel, logger }))
  route('POST', '/research/start', ({body}) => researchTasks.start(body))
  route('GET', '/research/tasks', ({query}) => researchTasks.list({limit:query.get('limit')}))
  route('GET', '/research/task', ({query}) => researchTasks.get(String(query.get('id'))))
  route('POST', '/research/cancel', ({body}) => researchTasks.cancel(String(body.id)))

  route('GET', '/monitor/rules', () => ({ ok: true, rules: repos.monitor.listRules() }))
  route('GET', '/monitor/runs', ({ query }) => ({ ok: true, runs: repos.monitor.listRuns(Number(query.get('limit') ?? 30)) }))
  route('GET', '/notifications', ({ query }) => ({
    ok: true,
    notifications: repos.monitor.listNotifications({ unreadOnly: query.get('unread') === '1', limit: Number(query.get('limit') ?? 50) }),
    unread: repos.monitor.unreadCount(),
  }))
  route('GET', '/sources', () => ({ ok: true, sources: sourceHealthRows(repos) }))
  route('GET', '/client-health', () => ({
    ok: true,
    client: typeof clientHealth === 'function' ? clientHealth() : { available: false, reason: 'not wired' },
    bundlePath: 'client/wrapped-bundle.js',
    hint: '面板按钮注入在 sidebar.footer.action；若 inGraph=false，说明浏览器半没有进入 Web boot graph。',
  }))
  route('GET', '/digest', () => ({ ok: true, digest: monitor.buildDigest() }))
  route('GET', '/search', ({ query }) => {
    const q = query.get('q') ?? ''
    if (!q.trim()) return { ok: true, jobs: [], companies: [] }
    return {
      ok: true,
      jobs: repos.jobs.listJobs({ query: q, limit: 12 }).map((j) => ({ id: j.id, label: `${j.company_name} · ${j.title}`, score: j.match_score })),
      companies: repos.jobs.listCompanies({ query: q, limit: 8 }).map((c) => ({ id: c.id, label: c.name })),
    }
  })

  // ── write ──────────────────────────────────────────────────────────────────
  route('POST', '/profile', async ({ body }) => ({ ok: true, profile: repos.profile.update(body) }))

  route('POST', '/profile/skill', async ({ body }) => {
    const skill = repos.profile.upsertSkill(body)
    repos.profile.syncProfileSkills()
    return { ok: true, skill }
  })

  route('POST', '/resume/import', async ({ body }) => {
    const { extractResumeText, parseResume, proposalToProfilePatch } = await import('./resume.js')
    let text = body.text
    let format = 'text'
    let notes = []
    let fileName = null
    if (!text) {
      if (!body.path) throw new HttpError('需要 path 或 text')
      const extracted = await extractResumeText(String(body.path), { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
      if (!extracted.ok) throw new HttpError(extracted.error ?? '提取失败', 422)
      text = extracted.text
      format = extracted.format ?? format
      notes = extracted.notes ?? []
      fileName = String(body.path).split(/[\\/]/).pop()
    }
    const proposal = parseResume(text, { fileName })
    const resume = repos.profile.addResume({
      label: body.label ?? fileName,
      targetRole: body.targetRole,
      language: body.language,
      fileName,
      filePath: body.path ?? null,
      mime: format,
      rawText: text,
      parsed: proposal,
      parseStatus: 'needs_review',
      parseNotes: [...notes, ...proposal.notes].join('；') || null,
      setActive: body.setActive !== false,
    })
    panel.publish({ kind: 'resume', resumeId: resume.id })
    return { ok: true, resumeId: resume.id, proposal, suggestedProfilePatch: proposalToProfilePatch(proposal), notes }
  })

  route('POST', '/resume/activate', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    const r = repos.profile.setActiveResume(String(body.id))
    panel.publish({ kind: 'resume', resumeId: r?.id })
    return { ok: true, active: r?.id ?? null }
  })

  route('POST', '/resume/compare', async ({ body }) => {
    if (!body.aId || !body.bId) throw new HttpError('缺少 aId/bId')
    return { ok: true, ...repos.profile.compareResumes(String(body.aId), String(body.bId)) }
  })

  route('POST', '/resume/apply', async ({ body }) => {
    // Commit the confirmed parts of a proposal into the profile.
    if (!body.patch) throw new HttpError('缺少 patch')
    repos.profile.update(body.patch)
    if (body.resumeId) repos.profile.updateResumeParsed(String(body.resumeId), body.proposal ?? {}, 'ok', '用户已确认')
    panel.publish({ kind: 'profile' })
    return { ok: true, profile: repos.profile.get(), completeness: repos.profile.completeness() }
  })

  route('POST', '/job/save', async ({ body }) => {
    let payload = { ...body }
    if (body.jdText) payload = { ...parsePastedJob(String(body.jdText), body), ...body }
    const result = repos.jobs.upsertJob(payload, {
      official: body.official === true,
      source: { sourceType: body.official ? 'official_careers' : 'manual', sourceName: body.sourceName, url: body.url },
    })
    panel.publish({ kind: 'jobs', jobId: result.id, created: result.created })
    return { ok: true, ...result, job: repos.jobs.getJob(result.id) }
  })

  route('POST', '/job/verify', async ({ body }) => {
    if (!body.id || !body.status) throw new HttpError('缺少 id/status')
    const result = repos.jobs.applyStatusObservation(String(body.id), {
      status: String(body.status),
      official: body.official === true,
      sourceType: body.official ? 'official_careers' : 'manual',
      sourceUrl: body.sourceUrl ?? null,
      evidence: body.evidence ?? null,
      note: body.note ?? null,
    })
    if (body.sourceUrl) repos.jobs.attachSource(String(body.id), { sourceType: body.official ? 'official_careers' : 'manual', url: String(body.sourceUrl), excerpt: body.evidence ?? null })
    panel.publish({ kind: 'jobs', jobId: body.id })
    return { ok: true, ...result }
  })

  route('POST', '/crawl', async ({ body }) => {
    const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).filter(Boolean).map(String).slice(0, 8)
    if (!urls.length) throw new HttpError('缺少 url')
    const dryRun = body.dryRun !== false
    const official = body.official !== false
    const results = []
    let created = 0
    let merged = 0
    for (const url of urls) {
      const page = await crawlListing(url, {
        timeoutMs: config.httpTimeoutMs,
        gapMs: config.httpGapMs,
        maxDetail: Number(body.maxDetail ?? 0),
      })
      if (!page.ok) {
        results.push({ url, ok: false, error: page.error, postings: [] })
        continue
      }
      const normalized = page.postings.map((posting) => postingToJob(posting, { company: body.company, pageUrl: page.url }))
      let imported = null
      if (!dryRun) {
        imported = repos.jobs.importPostings(normalized, {
          company: body.company,
          pageUrl: page.url,
          official,
          recruitType: body.recruitType ?? null,
          sourceName: official ? '官方招聘页（爬取）' : '第三方页面（爬取）',
        })
        created += imported.created.length
        merged += imported.merged.length
      }
      results.push({
        url: page.url,
        ok: true,
        strategy: page.strategy,
        signals: page.signals,
        warnings: page.warnings,
        count: normalized.length,
        imported: imported ? { created: imported.created.length, merged: imported.merged.length, failed: imported.failed } : null,
        postings: normalized.slice(0, 80).map((j) => ({
          title: j.title, company: j.company, location: j.location, recruitType: j.recruitType,
          deadline: j.deadline, applyUrl: j.applyUrl, skills: (j.skills ?? []).slice(0, 6),
        })),
      })
    }
    if (!dryRun) panel.publish({ kind: 'jobs' })
    return { ok: true, dryRun, official, results, totals: { urls: urls.length, created, merged } }
  })

  route('POST', '/job/delete', async ({ body }) => {
    const ids = [...new Set([...(Array.isArray(body.ids) ? body.ids : []), body.id].filter(Boolean).map(String))]
    if (!ids.length) throw new HttpError('缺少 id 或 ids')
    const deleted = ids.filter((id) => {
      try {
        return repos.jobs.deleteJob(id)
      } catch (err) {
        logger.warn('job delete failed', { id, error: String(err?.message ?? err) })
        return false
      }
    })
    panel.publish({ kind: 'jobs' })
    return { ok: true, requested: ids.length, deleted: deleted.length }
  })

  route('POST', '/job/note', async ({ body }) => {
    if (!body.id || !body.body) throw new HttpError('缺少 id/body')
    return { ok: true, note: repos.jobs.addNote(String(body.id), String(body.body)) }
  })

  route('POST', '/job/archive', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, job: repos.jobs.setArchived(String(body.id), body.archived !== false) }
  })

  route('GET', '/application', ({ query }) => {
    const id = query.get('id')
    if (!id) throw new HttpError('缺少 id')
    const application = repos.applications.get(String(id))
    if (!application) throw new HttpError('投递记录不存在', 404)
    return { ok: true, application, statusLabels: APPLICATION_STATUSES }
  })

  route('POST', '/application', async ({ body }) => {
    if(body.jobId && (!body.status || body.status==='saved')) {
      const existing=repos.db.get('SELECT id FROM application WHERE job_id=? AND archived=0 ORDER BY created_at DESC LIMIT 1',[String(body.jobId)])
      if(existing)return {ok:true,duplicate:true,application:repos.applications.get(existing.id)}
    }
    const application = repos.applications.create(body)
    panel.publish({ kind: 'applications', id: application.id })
    return { ok: true, application }
  })

  route('POST', '/application/update', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    const application = repos.applications.update(String(body.id), body)
    panel.publish({ kind: 'applications', id: body.id })
    return { ok: true, application }
  })

  route('POST', '/company', async ({ body }) => {
    const company = repos.jobs.upsertCompany(body)
    if (body.interest) repos.jobs.setWatch(company.id, body.interest, body.notes)
    panel.publish({ kind: 'company', id: company.id })
    return { ok: true, company }
  })

  route('POST', '/company/watch', async ({ body }) => {
    if (!body.companyId) throw new HttpError('缺少 companyId')
    return { ok: true, watch: repos.jobs.setWatch(String(body.companyId), body.interest ?? 'watch', body.note) }
  })

  route('POST', '/industry', async ({ body }) => ({ ok: true, industry: repos.intel.upsertIndustry(body) }))

  route('POST', '/report', async ({ body }) => {
    const report = repos.intel.saveReport(body)
    panel.publish({ kind: 'reports', id: report.id })
    return { ok: true, report }
  })

  route('POST', '/social/import', async ({ body }) => {
    const post = repos.intel.addForumPost(body)
    repos.knowledge.upsert({kind:'interview',title:body.title??'手动导入面经',company:body.company,role:body.jobTitle,platform:body.platform,url:body.url,body:body.content,completeness:'full',evidenceLevel:'C',sourceEntityType:'forum_post',sourceEntityId:post.id})
    if (post.duplicate) return { ok: true, duplicate: true, postId: post.id }
    const claims = Array.isArray(body.claims) ? body.claims.map((c) => repos.intel.addClaim({ ...c, postId: post.id, companyId: post.company_id, jobId: post.job_id })) : []
    const interview = body.interview ? repos.intel.addInterview({ ...body.interview, postId: post.id, url: body.url, companyId: post.company_id, jobId: post.job_id }) : null
    panel.publish({ kind: 'social', postId: post.id })
    return { ok: true, postId: post.id, claims, interview }
  })

  route('POST', '/bar/requirement', async ({ body }) => ({ ok: true, requirement: repos.intel.addRequirement(body) }))

  route('POST', '/monitor/rule', async ({ body }) => ({ ok: true, rule: repos.monitor.createRule(body) }))

  route('POST', '/monitor/rule/update', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, rule: repos.monitor.updateRule(String(body.id), body) }
  })

  route('POST', '/monitor/rule/delete', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, deleted: repos.monitor.deleteRule(String(body.id)) }
  })

  route('POST', '/monitor/run', async ({ body }) => {
    if (body.id) return { ok: true, result: await monitor.runRule(String(body.id)) }
    return { ok: true, ...(await monitor.runAll({ kinds: body.kinds })) }
  })

  route('POST', '/notification/read', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, notification: repos.monitor.markNotification(String(body.id), { read: true, dismissed: body.dismissed === true }) }
  })

  route('POST', '/match/rank', async () => {
    const profile = repos.profile.getWithResume()
    profile.__hash = repos.profile.hash()
    const ranked = repos.jobs.rankAll(profile)
    return {
      ok: true,
      total: ranked.length,
      top: ranked.slice(0, 50).map(({ job, analysis }) => ({
        id: job.id, company: job.company_name, title: job.title, score: analysis.score,
        band: analysis.band, bandLabel: analysis.bandLabel, hardBlocks: analysis.hardBlocks,
      })),
    }
  })

  route('POST', '/feedback', async ({ body }) => ({ ok: true, feedback: repos.monitor.addFeedback(body), summary: repos.monitor.feedbackSummary() }))

  // ── 校招作战计划 ───────────────────────────────────────────────────────────
  const planInputs = () => {
    const profile = repos.profile.get()
    const completeness = repos.profile.completeness()
    const bands = new Map(repos.db.all('SELECT job_id, band FROM match_result').map((r) => [r.job_id, r.band]))
    const jobs = repos.jobs.listJobs({ limit: 500 }, profile).map((j) => ({ ...j, band: bands.get(j.id) ?? null }))
    return {
      profile,
      completeness,
      jobs,
      applications: repos.applications.list({ limit: 500 }),
      followUps: repos.applications.followUps(),
      events: repos.intel.listEvents({ limit: 100 }),
    }
  }

  route('GET', '/plan', ({ query }) => {
    const inputs = planInputs()
    const now = query.get('date') ?? nowIso().slice(0, 10)
    const plan = buildPlan({ ...inputs, now })
    return {
      ok: true,
      ...plan,
      events: inputs.events,
      signals: repos.intel.listSignals({ limit: 100 }),
      units: repos.intel.listUnits({}),
      recruitLabels: RECRUIT_LABEL,
    }
  })

  route('POST', '/plan/brief', async ({ body }) => {
    const inputs = planInputs()
    const now = nowIso().slice(0, 10)
    const plan = buildPlan({ ...inputs, now })
    const signals = repos.intel.listSignals({ industryId: body.industryId, companyId: body.companyId, limit: 300 })
    const units = repos.intel.listUnits({ companyId: body.companyId })
    const bar = repos.intel.barFor({ companyId: body.companyId, jobId: body.jobId })
    const brief = buildBrief({
      profile: inputs.profile, completeness: inputs.completeness, plan,
      jobs: inputs.jobs, applications: inputs.applications, signals, units, bar, now,
    })
    let reportId = null
    if (body.save !== false) {
      const report = repos.intel.saveReport({
        kind: 'summary',
        title: `求职作战计划 ${now}`,
        body: brief.markdown,
        sources: [...new Set(signals.map((s) => s.source).filter(Boolean))].slice(0, 20),
        dataAsOf: now,
        companyId: body.companyId ?? null,
      })
      reportId = report.id
      panel.publish({ kind: 'reports', id: reportId })
    }
    return { ok: true, reportId, markdown: brief.markdown, missing: brief.missing, stats: brief.stats }
  })

  route('POST', '/event', async ({ body }) => ({ ok: true, event: repos.intel.addEvent(body) }))
  route('POST', '/event/delete', async ({ body }) => ({ ok: true, deleted: repos.intel.deleteEvent(String(body.id ?? '')) }))
  route('POST', '/unit', async ({ body }) => ({ ok: true, unit: repos.intel.upsertUnit(body) }))
  route('POST', '/outlook', async ({ body }) => ({ ok: true, signal: repos.intel.addSignal(body) }))
  route('GET', '/signals', ({ query }) => ({
    ok: true,
    signals: repos.intel.listSignals({
      scope: query.get('scope') ?? undefined,
      industryId: query.get('industryId') ?? undefined,
      companyId: query.get('companyId') ?? undefined,
      limit: Number(query.get('limit') ?? 200),
    }),
  }))
  route('GET', '/units', ({ query }) => ({ ok: true, units: repos.intel.listUnits({ companyId: query.get('companyId') ?? undefined }) }))

  route('POST', '/export', async () => ({ ok: true, ...exporter.exportData('all') }))
  route('POST', '/backup', async () => ({ ok: true, ...exporter.backupDatabase() }))
  route('POST', '/data/delete/prepare', async () => ({ ok: true, ...exporter.prepareDelete('all') }))
  route('POST', '/data/delete/commit', async ({ body }) => ({ ok: true, ...exporter.commitDelete(String(body.token ?? '')) }))
  route('POST', '/search/web', async ({ body }) => {
    if (!search) throw new HttpError('搜索能力不可用', 503)
    const res = await search(String(body.query ?? ''), Number(body.maxResults ?? 8))
    if (!res.ok) throw new HttpError(res.error ?? '搜索失败', 502)
    return { ok: true, sources: res.sources }
  })

  // ── 简历知识库 / 微调 / LaTeX 工作室 ───────────────────────────────────────
  const uploadDir = path.join(config.dataDir, 'resumes')
  const saveUpload = (fileName, base64) => {
    fs.mkdirSync(uploadDir, { recursive: true })
    const safe = String(fileName ?? 'resume').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'resume'
    const target = path.join(uploadDir, `${Date.now()}-${safe}`)
    fs.writeFileSync(target, Buffer.from(String(base64 ?? ''), 'base64'))
    return target
  }

  route('POST', '/resume/upload', async ({ body }) => {
    if (!body.dataBase64 && !body.path) throw new HttpError('需要文件内容或本机路径')
    const { extractResumeText, parseResume, proposalToProfilePatch } = await import('./resume.js')
    const filePath = body.path ? String(body.path) : saveUpload(body.fileName, body.dataBase64)
    const extracted = await extractResumeText(filePath, { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
    if (!extracted.ok) throw new HttpError(extracted.error ?? '提取失败', 422)
    const proposal = parseResume(extracted.text, { fileName: body.fileName ?? path.basename(filePath) })
    const resume = repos.profile.addResume({
      label: body.label ?? body.fileName ?? path.basename(filePath),
      targetRole: body.targetRole,
      language: body.language,
      fileName: body.fileName ?? path.basename(filePath),
      filePath,
      mime: extracted.format ?? 'file',
      rawText: extracted.text,
      parsed: proposal,
      parseStatus: 'needs_review',
      parseNotes: [...(extracted.notes ?? []), ...proposal.notes].join('；') || null,
      sourceType: 'upload',
      setActive: body.setActive !== false,
    })
    let seeded = []
    if (body.seedVault !== false) seeded = repos.profile.importExperiencesFromResume(proposal, resume.id)
    panel.publish({ kind: 'resume', resumeId: resume.id })
    return { ok: true, resumeId: resume.id, proposal, seeded: seeded.length, suggestedProfilePatch: proposalToProfilePatch(proposal), notes: extracted.notes }
  })

  route('GET', '/experience', ({ query }) => {
    const experiences = repos.profile.listExperiences({ kind: query.get('kind') ?? undefined })
    const byKind = {}
    for (const exp of experiences) byKind[exp.kind] = (byKind[exp.kind] ?? 0) + 1
    return { ok: true, total: experiences.length, byKind, kindLabels: KIND_LABEL, experiences }
  })
  route('POST', '/experience', async ({ body }) => ({ ok: true, experience: repos.profile.addExperience(body) }))
  route('POST', '/experience/update', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, experience: repos.profile.updateExperience(String(body.id), body) }
  })
  route('POST', '/experience/delete', async ({ body }) => ({ ok: true, deleted: repos.profile.deleteExperience(String(body.id ?? '')) }))

  route('POST', '/resume/tailor', async ({ body }) => {
    const job = repos.jobs.getJob(String(body.jobId ?? ''))
    if (!job) throw new HttpError('目标岗位不存在', 404)
    const experiences = repos.profile.listExperiences()
    if (!experiences.length) throw new HttpError('素材库为空：先上传简历或手动添加经历', 409)
    const plan = planTailor({
      experiences,
      job,
      maxEntries: Number(body.maxEntries ?? 6),
      bulletsPerEntry: Number(body.bulletsPerEntry ?? 4),
    })
    const profile = repos.profile.get()
    const sections = sectionsFromSelection(plan.selected)
    const texSource = renderResumeTex({ profile, sections })
    const rawText = renderResumeText({ profile, sections })
    if (body.dryRun !== false) {
      return { ok: true, dryRun: true, plan, sections, texSource, preview: rawText }
    }
    const label = body.label || `${job.company_name}·${job.title} 定制版`
    const version = repos.profile.createVersionFromSections({
      label, sections, profile, rawText, texSource,
      parentVersionId: body.baseVersionId ?? null,
      targetJobId: job.id,
      sourceType: 'tailored',
      targetRole: job.title,
      setActive: false,
    })
    panel.publish({ kind: 'resume', resumeId: version.id })
    return { ok: true, versionId: version.id, label, plan, texSource, preview: rawText }
  })

  route('POST', '/resume/delete', async ({ body }) => {
    const id = String(body.id ?? '')
    if (!id) throw new HttpError('缺少 id')
    const ok = repos.profile.deleteResume(id)
    panel.publish({ kind: 'resume', resumeId: null })
    return { ok, deleted: ok }
  })

  route('POST', '/resume/tex', async ({ body }) => {
    const id = String(body.versionId ?? '')
    const resume = repos.profile.getResume(id)
    if (!resume) throw new HttpError('版本不存在', 404)
    if (body.tex !== undefined) {
      repos.profile.setResumeTex(id, String(body.tex))
      panel.publish({ kind: 'resume', resumeId: id })
      return { ok: true, saved: true, chars: String(body.tex).length }
    }
    if (body.regenerate === true) {
      const tex = renderResumeTex({ profile: repos.profile.get(), sections: resume.parsed?.sections ?? [], title: resume.label })
      repos.profile.setResumeTex(id, tex)
      panel.publish({ kind: 'resume', resumeId: id })
      return { ok: true, tex, regenerated: true }
    }
    return { ok: true, tex: repos.profile.getResumeTex(id), label: resume.label }
  })

  route('POST', '/resume/compile', async ({ body }) => {
    const id = String(body.versionId ?? '')
    const tex = body.tex !== undefined ? String(body.tex) : repos.profile.getResumeTex(id)
    if (!tex) throw new HttpError('这一版还没有 LaTeX 源码', 409)
    if (body.tex !== undefined) repos.profile.setResumeTex(id, tex)
    const engines = detectEngines()
    const result = await compileTex(tex, { dataDir: config.dataDir, timeoutMs: 60_000, preferEngine: engines[0]?.engine })
    return {
      ok: result.ok, versionId: id, engine: result.engine, cached: result.cached === true, ms: result.ms,
      pdfPath: result.pdfPath ?? null, error: result.error ?? null, logTail: result.ok ? null : result.log,
      availableEngines: engines.map((e) => e.engine), hash: result.hash,
    }
  })

  route('GET', '/resume/pdf', ({ query, res }) => {
    const id = String(query.get('id') ?? '')
    const tex = repos.profile.getResumeTex(id)
    if (!tex) throw new HttpError('这一版还没有 PDF（缺 LaTeX 源码）', 404)
    const hash = sha1ish(tex)
    const pdfPath = path.join(config.dataDir, 'tex', hash, 'resume.pdf')
    if (!fs.existsSync(pdfPath)) throw new HttpError('PDF 还没编译过，先调用编译', 404)
    const data = fs.readFileSync(pdfPath)
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
    res.end(data)
    return 'sent'
  })

  route('GET', '/resume/engines', () => ({ ok: true, engines: detectEngines() }))
  route('GET', '/resume/lineage', ({ query }) => ({ ok: true, lineage: repos.profile.resumeLineage(String(query.get('id') ?? '')) }))

  route('GET', '/guide', ({ query }) => {
    const company = query.get('company') ?? undefined
    let careersUrl = query.get('careersUrl') ?? null
    if (!careersUrl && company) careersUrl = repos.jobs.resolveCompany(company, false)?.careers_url ?? null
    return {
      ok: true,
      ...buildRetrievalGuide({ company, url: query.get('url') ?? undefined, role: query.get('role') ?? undefined, careersUrl }),
    }
  })

  route('GET', '/ats', () => ({
    ok: true,
    catalog: Object.entries(ATS_SPECS).map(([key, spec]) => ({
      ats: key, label: spec.label, docUrl: spec.docUrl, hint: spec.hint,
      example: spec.api('your-token'),
    })),
    note: '这些都是各平台对外发布的只读岗位接口，无需登录与 key；把 {token} 换成公司对应的看板标识即可。',
  }))

  route('GET', '/runtime/health', async () => ({
    ok: true,
    ...(await runtimeHealth({ config, db, clientHealth, webService })),
  }))

  route('GET', '/runtime/web-providers', () => {
    try {
      const providers = webService?.listProviders ? webService.listProviders() : null
      return { ok: true, providers }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  })

  route('POST', '/runtime/setup', async ({ body }) => {
    const result = await installPdfLibs(config.pythonPath)
    return { ok: result.ok, ...result, next: result.ok ? 'PDF 依赖已装到项目内 runtime/pylib，重试导入简历即可。' : '安装失败，请检查网络或手动执行 scripts/setup-runtime.mjs。' }
  })

  // ── 个人资料库 ─────────────────────────────────────────────────────────────
  route('GET', '/documents', ({ query }) => ({
    ok: true,
    ...repos.profile.documentStats(),
    categories: DOC_LABEL,
    documents: repos.profile.listDocuments({
      category: query.get('category') ? query.get('category').split(',') : undefined,
      query: query.get('q') ?? undefined,
      verified: query.get('verified') === null ? undefined : query.get('verified') === '1',
    }),
  }))

  route('POST', '/document/upload', async ({ body }) => {
    if (!body.dataBase64 && !body.path) throw new HttpError('需要文件内容或本机路径')
    const fileName = body.fileName ?? (body.path ? path.basename(String(body.path)) : 'document')
    const ext = String(fileName).toLowerCase()
    let filePath = body.path ? String(body.path) : null
    if (!filePath) {
      const dir = path.join(config.dataDir, 'documents')
      fs.mkdirSync(dir, { recursive: true })
      const safe = fileName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'document'
      filePath = path.join(dir, `${Date.now()}-${safe}`)
      fs.writeFileSync(filePath, Buffer.from(String(body.dataBase64), 'base64'))
    }
    // 图片型证明不做 OCR，只登记文件并提示补字段。
    let text = ''
    let format = 'image'
    if (!/\.(png|jpe?g|webp)$/i.test(ext)) {
      const { extractResumeText } = await import('./resume.js')
      const extracted = await extractResumeText(filePath, { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
      if (!extracted.ok) throw new HttpError(extracted.error ?? '文件解析失败', 422)
      text = extracted.text ?? ''
      format = extracted.format ?? 'file'
    }
    const proposal = proposeDocument({ fileName, text, filePath, mime: format })
    if (body.category) proposal.category = String(body.category)
    const document = body.save === false ? null : repos.profile.addDocument({
      ...proposal, rawText: text, filePath, fileName, mime: format, verified: body.verified === true,
    })
    if (document) panel.publish({ kind: 'resume', resumeId: null })
    return { ok: true, proposal, document, ocrSkipped: format === 'image' }
  })

  route('POST', '/document/update', async ({ body }) => {
    if (!body.id) throw new HttpError('缺少 id')
    return { ok: true, document: repos.profile.updateDocument(String(body.id), body) }
  })

  route('POST', '/document/delete', async ({ body }) => ({ ok: true, deleted: repos.profile.deleteDocument(String(body.id ?? '')) }))

  // ── 网申信息卡 / 漏斗 ─────────────────────────────────────────────────────
  route('GET', '/apply-card', () => {
    const card = buildApplyCard({
      profile: repos.profile.get(),
      documents: repos.profile.listDocuments({}),
      experiences: repos.profile.listExperiences(),
      versions: repos.profile.listResumes(),
    })
    return { ok: true, ...card, text: renderApplyCardText(card) }
  })

  route('GET', '/funnel', () => ({ ok: true, ...repos.applications.funnel() }))

  // ── SSE ────────────────────────────────────────────────────────────────────
  route('GET', '/events', ({ req, res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(`retry: 3000\n\n`)
    res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`)
    if (panel.lastNavigate) res.write(`event: navigate\ndata: ${JSON.stringify(panel.lastNavigate)}\n\n`)
    const unsubscribe = panel.subscribe((payload) => {
      res.write(`event: ${payload.kind ?? 'message'}\ndata: ${JSON.stringify(payload)}\n\n`)
    })
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* connection gone */
      }
    }, 20_000)
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
    req.on('close', close)
    req.on('error', close)
    return 'streaming'
  })

  // ── dispatcher ─────────────────────────────────────────────────────────────
  const handler = async (req, res) => {
    try {
      assertSameOrigin(req)
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      let path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
      if (!path.startsWith('/')) path = `/${path}`
      const method = (req.method ?? 'GET').toUpperCase()
      for (const r of routes) {
        if (r.method !== method) continue
        const m = r.regex.exec(path)
        if (!m) continue
        const query = url.searchParams
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
        const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? await readBody(req) : {}
        const result = await r.handler({ req, res, query, params, body })
        if (result === 'streaming' || result === 'sent') return
        if (!res.headersSent) sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${path}` })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status >= 500) logger.error('career api error', { url: req.url, error: String(err?.stack ?? err) })
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String(err?.message ?? err) })
      else {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  logger.info('career routes registered', { prefix: API_PREFIX, routes: routes.length })
  return { dispose:()=>{researchTasks.dispose();dispose?.()}, routes: routes.length }
}
