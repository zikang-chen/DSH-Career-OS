// Agent-facing tools. Every tool returns a JSON string; long text lives in Markdown
// fields so the model can quote it without re-fetching.
import fs from 'node:fs'
import path from 'node:path'
import { APPLICATION_LABEL, APPLICATION_STATUSES, INTERNSHIP_LABEL, JOB_STATUSES, MATCH_BANDS, RECRUIT_LABEL, RECRUIT_TYPES, STATUS_LABEL, analyzeMatch, extractSkills } from './domain.js'
import { crawlListing, extractReportedTotal, postingToJob, walkJsonForPostings } from './crawl.js'
import { ATS_SPECS, detectAts, fetchAtsPostings, normalizeAtsPayload } from './ats.js'
import { assertReplayable, describeJsonShape, parseCurl, replayRequest } from './curl.js'
import { browserProfileDir, capturePageJson, closeBrowser, findBrowserExecutable, openForLogin } from './browser.js'
import { probePortals, resolvePortal } from './portal.js'
import { fetchJdDetail, resolveJdProvider } from './jd.js'
import { checkResumeQuality } from './quality.js'
import { findJobsForMe, jdCompleteness, prepResumeForJob, summarizeApplications } from './workflows.js'
import { envelope } from './envelope.js'
import { buildInterviewPlan } from './interview.js'
import { SITE_PROFILES, classifyRecruitType, filterByRecruitType, getSiteProfile, loginUrlForConnector } from './sites.js'
import { RESUME_SKILLS, analyzeBullets } from './resume_skills.js'
import { captureSite, sourceHealthRows } from './site-capture.js'
import { fetchOfferShowSalaryHighlights } from './offershow.js'
import {processKnowledgeOcr,ocrStatus} from './ocr.js'
import { STALE_DAYS, captureFreshness, diffCaptures, diffJdSnapshots, scopeKeyOf } from './repo/captures.js'
import { buildRetrievalGuide, guideInline } from './guide.js'
import { installPdfLibs, runtimeHealth } from './runtime.js'
import { compileTex, detectEngines, renderResumeTex, renderResumeText } from './latex.js'
import { KIND_LABEL, planTailor, sectionsFromSelection, suggestKindOrder } from './tailor.js'
import { auditVault, planMerge } from './merge.js'
import { DOC_LABEL, planDocumentSelection, proposeDocument, renderDocumentLines } from './documents.js'
import { buildApplyCard, renderApplyCardText } from './applycard.js'
import { extractResumeText, parseResume, proposalToProfilePatch } from './resume.js'
import { parsePastedJob, suggestSocialQueries } from './sources.js'
import { buildBrief, buildPlan, buildTimeline, seasonRuleSet } from './plan.js'
import { arr, companyKey, nowIso, parseJson, str, today } from './util.js'

const json = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text
}

/**
 * Build a registry-ready tool definition. `output.schema` is a raw supported JSON
 * Schema; `parameters` is an object-rooted property map.
 */
function makeTool({ name, description, params = {}, required = [], handler }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: params, ...(required.length ? { required } : {}) },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const result = await handler(args ?? {})
      return json(result)
    },
  }
}

const S = (description) => ({ type: 'string', description })
const N = (description) => ({ type: 'number', description })
const B = (description) => ({ type: 'boolean', description })
const SA = (description) => ({ type: 'array', items: { type: 'string' }, description })

export function registerCareerTools(ctx, deps) {
  const { repos, config, monitor, panel, logger } = deps
  const registered = []
  const add = (definition) => {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }

  add(makeTool({name:'career_knowledge',description:'分类知识库：列出/读取岗位JD、面经、公告、薪资和研究，按公司/岗位/平台/整理状态检索；整理不覆盖原文。',params:{action:S('list|get|update|stats'),id:S('资料id'),query:S('全文关键词'),kind:S('job|interview|announcement|salary|research'),company:S('公司'),platform:S('来源平台'),status:S('inbox|active|archived'),role:S('整理后的岗位方向'),notes:S('整理备注'),tags:SA('整理标签'),limit:N('页大小'),offset:N('偏移')},handler:(args)=>{
    const action=args.action??'list'
    if(action==='get')return {ok:true,item:repos.knowledge.get(String(args.id))}
    if(action==='stats')return {ok:true,stats:repos.knowledge.stats()}
    if(action==='update'){const patch={};for(const key of ['status','company','role','notes','tags'])if(args[key]!==undefined)patch[key]=args[key];return {ok:true,item:repos.knowledge.update(String(args.id),patch)}}
    if(action!=='list')throw new Error('action必须list/get/update/stats')
    return {ok:true,...repos.knowledge.list(args),stats:repos.knowledge.stats()}
  }}))
  add(makeTool({name:'career_knowledge_ocr',description:'对知识库关联图片执行本机OCR并保留原图哈希/逐图结果。识别默认待人工核对；不上传第三方、不覆盖作者正文。',params:{action:S('status|recognize|agent_prepare|agent_save；agent_prepare后必须read_image再保存；人工确认仅在界面'),id:S('知识库资料id'),index:N('图片序号，从1开始'),text:S('Agent实际看图后的逐字转录，不清楚标〔无法辨认〕')},handler:(args)=>args.action==='status'?ocrStatus({dataDir:config.dataDir}):args.action==='review'?{ok:false,error:'人工核对仅限用户在知识库界面确认，Agent不能代确认'}:processKnowledgeOcr({...args,action:args.action??'recognize'},{repos,config})}))

  // ── system / profile ───────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_status',
    description: 'CareerOS 总览：数据库与 schema 版本、画像完成度、岗位/投递/提醒计数、数据源健康状态。每次开始求职相关对话或排查问题先调用。',
    params: {},
    handler: () => {
      const db = repos.db.info()
      return {
        ok: true,
        db,
        profileCompleteness: repos.profile.completeness(),
        jobStats: repos.jobs.stats(),
        applicationStats: repos.applications.stats(),
        unreadNotifications: repos.monitor.unreadCount(),
        sources: sourceHealthRows(repos).map((s) => ({
          connector: s.connector, displayName: s.display_name, accessMode: s.access_mode,
          enabled: s.enabled, needsUser: s.needsUser, lastOkAt: s.last_ok_at, lastError: s.last_error,
          rateLimitNote: s.rate_limit_note, capabilities: s.capabilities, sites: s.sites,
        })),
        tools: registered.slice(),
        dataDir: config.dataDir,
        limits: {
          supportedResumeFormats: ['.md', '.txt', '.docx', '.pdf'],
          blockedSources: '第三方招聘平台与论坛需登录：用「专用浏览器 + CDP」复用你的登录态采集（career_site_capture：site=xhs/boss/51job/offershow），不破解签名、不绕登录、单页低频；也可用 career_forum_import 手动导入。',
        },
      }
    },
  }))

  add(makeTool({
    name: 'career_profile_get',
    description: '读取求职画像与偏好（学历、毕业时间、可实习时间、目标行业/岗位/城市、技能、排除条件），并返回完成度清单。个性化建议前必须先看它。',
    params: {},
    handler: () => {
      const profile = repos.profile.get()
      const active = repos.profile.activeResume()
      return {
        ok: true,
        profile,
        completeness: repos.profile.completeness(),
        activeResume: active ? { id: active.id, label: active.label, parseStatus: active.parse_status, chars: (active.raw_text ?? '').length } : null,
        resumeVersions: repos.profile.listResumes(),
        caveat: '画像里没写的字段一律是 null，不要替用户猜测或补全。',
      }
    },
  }))

  add(makeTool({
    name: 'career_profile_update',
    description: '更新求职画像/偏好。字段全部可选，只改传入的字段。skills 传 [{name,level,years,verified}]；preferences 可含 weights 覆盖匹配权重。',
    params: {
      displayName: S('姓名/显示名'),
      headline: S('一句话定位，如「计算机大三 · 找产品实习」'),
      school: S('学校'), degree: S('学历：本科/硕士/博士'), major: S('专业'),
      gradYear: N('毕业年份，如 2027'),
      availabilityStart: S('可开始实习日期 YYYY-MM-DD'), availabilityEnd: S('可实习结束日期'),
      weeklyDays: N('每周可出勤天数 1-7'),
      internshipTypes: SA('期望实习类型：daily/summer/winter/long/short/other'),
      cities: SA('目标城市'),
      remotePref: S('onsite|remote|hybrid|any'),
      targetIndustries: SA('目标行业'), targetRoles: SA('目标岗位方向'), targetCompanies: SA('目标企业'),
      excluded: SA('排除条件，如「销售」「单休」「不提供转正」'),
      salaryMin: N('期望日薪/月薪下限（数字，仅用于筛选）'),
      skills: { type: 'array', items: { type: 'object' }, description: '技能数组 [{name,level,years,verified}]' },
      preferences: { type: 'object', description: '偏好与权重 {weights:{qualification,experience,interest,logistics,growth,freshness}}' },
      onboarded: B('是否完成引导'),
      // 网申信息卡要用的字段（v9）
      phone: S('手机号（只存本机）'), email: S('邮箱'),
      birthDate: S('出生日期 YYYY-MM-DD'), gender: S('性别'),
      politicalStatus: S('政治面貌，如 共青团员/中共党员/群众'),
      hometown: S('籍贯'), currentCity: S('现居城市'),
      gpa: S('GPA 原文，如 3.72/4.0'), rankText: S('专业排名原文，如 4/71'),
    },
    handler: (args) => {
      const updated = repos.profile.update(args)
      if (Array.isArray(args.skills)) {
        for (const s of args.skills) {
          if (s?.name) repos.profile.upsertSkill({ name: s.name, level: s.level, years: s.years, verified: s.verified === true })
        }
        repos.profile.syncProfileSkills()
      }
      repos.profile.update({ onboarded: repos.profile.completeness().percent >= 70 })
      return { ok: true, profile: repos.profile.get(), completeness: repos.profile.completeness(), note: '画像已更新；重新运行 career_match_rank 可刷新岗位排序。', _updated: Boolean(updated) }
    },
  }))

  // ── resume ─────────────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_resume_import',
    description: '导入简历：给 path（.md/.txt/.docx/.pdf）或直接给 text。返回「解析候选」，不会自动写入画像——必须让用户确认后再调用 career_profile_update 落库。绝不编造经历。',
    params: {
      path: S('简历文件绝对路径'),
      text: S('直接粘贴的简历全文'),
      label: S('版本标签，如「产品方向-v1」'),
      targetRole: S('该版本针对的岗位'),
      language: S('zh 或 en'),
      setActive: B('是否设为当前版本，默认 true'),
    },
    required: [],
    async handler(args) {
      let text = str(args.text, 400000)
      let format = 'text'
      let notes = []
      let fileName = null
      if (!text) {
        if (!args.path) throw new Error('需要 path 或 text')
        const extracted = await extractResumeText(String(args.path), { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
        if (!extracted.ok) {
          return {
            ok: false,
            error: extracted.error ?? '简历文本提取失败',
            notes: extracted.notes,
            fallback: '请让用户把简历文本粘贴进对话（text 参数），或用文档转换能力把原文件转成 .docx/.md 再导入。',
          }
        }
        text = extracted.text
        format = extracted.format ?? format
        notes = extracted.notes ?? []
        fileName = String(args.path).split(/[\\/]/).pop()
      }
      const proposal = parseResume(text, { fileName })
      const resume = repos.profile.addResume({
        label: args.label ?? fileName ?? undefined,
        targetRole: args.targetRole,
        language: args.language,
        fileName,
        filePath: args.path ?? null,
        mime: format,
        rawText: text,
        parsed: proposal,
        parseStatus: proposal.confidence >= 0.5 ? 'needs_review' : 'needs_review',
        parseNotes: [...notes, ...proposal.notes].join('；') || null,
        setActive: args.setActive !== false,
      })
      return {
        ok: true,
        resumeId: resume.id,
        format,
        chars: text.length,
        notes,
        proposal,
        suggestedProfilePatch: proposalToProfilePatch(proposal),
        next: '把 proposal 读给用户确认（逐项列出不确定的地方），确认后才调用 career_profile_update 写入；未确认的内容不得当作事实引用。',
      }
    },
  }))

  add(makeTool({
    name: 'career_resume_list',
    description: '列出简历版本（含当前激活版本、解析状态、字符数）。',
    params: {},
    handler: () => ({ ok: true, versions: repos.profile.listResumes(), activeId: repos.profile.activeResume()?.id ?? null }),
  }))

  add(makeTool({
    name: 'career_resume_delete',
    description: '删除一个简历版本（原文与解析结果一起删）。素材库里的经历不受影响。用于清理演示/导错的版本。',
    params: { id: S('简历版本 id') },
    required: ['id'],
    handler: (args) => {
      const ok = repos.profile.deleteResume(String(args.id))
      panel.publish({ kind: 'resume', resumeId: null })
      return { ok, deleted: ok }
    },
  }))

  add(makeTool({
    name: 'career_resume_activate',
    description: '切换当前使用的简历版本。',
    params: { id: S('简历版本 id') },
    required: ['id'],
    handler: (args) => {
      const resume = repos.profile.setActiveResume(String(args.id))
      if (!resume) throw new Error('简历版本不存在')
      return { ok: true, active: { id: resume.id, label: resume.label } }
    },
  }))

  add(makeTool({
    name: 'career_resume_compare',
    description: '对比两个简历版本的文本差异（新增/删除的行）。',
    params: { aId: S('版本 A id'), bId: S('版本 B id') },
    required: ['aId', 'bId'],
    handler: (args) => ({ ok: true, ...repos.profile.compareResumes(String(args.aId), String(args.bId)) }),
  }))

  add(makeTool({
    name: 'career_resume_match',
    description: 'JD × 简历匹配分析：给出命中/缺失关键词、硬性资格缺口、需要突出的经历，并生成定制建议。只基于简历已有内容，不得编造。',
    params: { jd: S('岗位 JD 文本'), jobId: S('或给出库里岗位 id'), resumeId: S('指定简历版本，默认当前版本') },
    handler: (args) => {
      let jd = str(args.jd, 40000)
      let job = null
      if (!jd && args.jobId) {
        job = repos.jobs.getJob(String(args.jobId))
        if (!job) throw new Error('岗位不存在')
        jd = `${job.title}\n${job.description ?? ''}\n${job.requirements ?? ''}`
      }
      if (!jd) throw new Error('需要 jd 或 jobId')
      const resume = args.resumeId ? repos.profile.getResume(String(args.resumeId)) : repos.profile.activeResume()
      if (!resume) throw new Error('还没有简历版本，先 career_resume_import')
      const resumeText = `${resume.raw_text ?? ''}\n${JSON.stringify(resume.parsed ?? {})}`
      const jdSkills = extractSkills(jd)
      const resumeSkills = new Set(extractSkills(resumeText).map((s) => s.toLowerCase()))
      const hit = jdSkills.filter((s) => resumeSkills.has(s.toLowerCase()))
      const gaps = jdSkills.filter((s) => !resumeSkills.has(s.toLowerCase()))
      const profile = repos.profile.get()
      return {
        ok: true,
        resumeVersion: { id: resume.id, label: resume.label },
        job: job ? { id: job.id, title: job.title, company: job.company_name } : null,
        jdSkills,
        matched: hit,
        gaps,
        gapActions: gaps.slice(0, 8).map((g) => `补强 ${g}：用真实做过的课程/项目/实习把这项写具体，没有就不要写`),
        profileGaps: [profile.school ? null : '画像缺少学校', profile.grad_year ? null : '画像缺毕业年份'].filter(Boolean),
        wording: '匹配分析只说明「简历与 JD 的字面/能力覆盖」，不代表通过率；不要承诺结果。',
        next: '输出「改哪几句、加哪个项目、删哪句虚话」的具体建议，并注明哪些是已知事实、哪些需要用户补充。',
      }
    },
  }))

  // ── jobs ───────────────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_job_save',
    description: '保存/合并一个岗位。可传结构化字段，也可传 jdText 让系统解析。自动做公司归一化+岗位去重；重复岗位会合并来源而不是新建。official=true 表示来自官方招聘页（可更新招聘状态）。',
    params: {
      company: S('公司名（必填）'), title: S('岗位名（必填）'),
      jdText: S('岗位 JD 原文，用于解析地点/技能/截止日等'),
      location: S('工作地点'), department: S('部门/团队'), businessUnit: S('业务线'),
      url: S('岗位原始链接'), jobCode: S('官方岗位编号'),
      internshipType: S('daily|summer|winter|long|short|other'),
      remoteType: S('onsite|remote|hybrid'),
      daysPerWeek: N('每周出勤天数'), deadline: S('截止日期 YYYY-MM-DD'),
      gradeLimit: S('年级/毕业年限要求'), salaryText: S('薪酬（公开且可验证才填）'),
      description: S('岗位描述'), requirements: S('招聘要求'),
      recruitType: S('秋招=autumn_campus / 春招=spring_campus / summer / daily / other'),
      applyUrl: S('投递地址（申请页 URL）'),
      skills: SA('技能要求'), tags: SA('标签'),
      status: S('招聘状态：OPEN/CLOSED/UPCOMING/UNVERIFIED/STALE/UNKNOWN'),
      official: B('是否官方来源'),
      conversionPossible: B('是否公开说明有转正机会（未知就不要传）'),
      sourceName: S('来源名称，如「字节跳动招聘官网」'),
    },
    required: ['company', 'title'],
    handler: (args) => {
      let payload = { ...args }
      if (args.jdText) {
        const parsed = parsePastedJob(String(args.jdText), args)
        payload = { ...parsed, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')), company: args.company, title: args.title }
      }
      const result = repos.jobs.upsertJob(payload, {
        official: args.official === true,
        source: { sourceType: args.official ? 'official_careers' : 'manual', sourceName: args.sourceName, url: args.url },
      })
      const job = repos.jobs.getJob(result.id)
      return {
        ok: true,
        created: result.created,
        mergedBy: result.reason,
        statusChange: result.statusChange,
        job: { id: job.id, title: job.title, company: job.company_name, location: job.location, status: job.status, statusVerifiedAt: job.status_verified_at, deadline: job.deadline, skills: job.skills },
        note: result.created ? '新岗位已入库' : '已合并到已有岗位（来源已追加）',
      }
    },
  }))

  add(makeTool({
    name: 'career_job_search',
    description: '检索岗位库：自然语言关键词 + 结构化筛选（公司/城市/状态/实习类型/技能/最低匹配分/截止日）。返回时说明检索范围与未覆盖渠道。',
    params: {
      query: S('关键词，如「AI 产品 北京」'),
      company: S('公司名过滤'), location: S('城市过滤'),
      status: SA('招聘状态过滤'), internshipType: SA('实习类型过滤'),
      skill: S('技能关键词'), minScore: N('最低匹配分'), deadlineBefore: S('截止日期早于 YYYY-MM-DD'),
      limit: N('返回条数，默认 30'),
    },
    handler: (args) => {
      const profile = repos.profile.getWithResume()
      const rows = repos.jobs.listJobs({ ...args, limit: args.limit ?? 30 }, profile)
      return {
        ok: true,
        count: rows.length,
        scope: {
          searchedFields: ['岗位标题', '公司', '地点', 'JD 描述', '招聘要求'],
          sourcesCovered: '仅本地已入库岗位（来源见每条的 provenance）；未访问任何第三方招聘平台',
          caveat: '库外岗位不在结果内。需要新岗位请用 career_jobs_sync 或手动粘贴。',
        },
        jobs: rows.map((j) => ({
          id: j.id, company: j.company_name, title: j.title, location: j.location,
          internshipType: INTERNSHIP_LABEL[j.internship_type] ?? j.internship_type,
          status: j.status, statusLabel: STATUS_LABEL[j.status] ?? j.status,
          statusVerifiedAt: j.status_verified_at, deadline: j.deadline,
          matchScore: j.match_score, url: j.source_url ?? null, skills: j.skills,
        })),
      }
    },
  }))

  add(makeTool({
    name: 'career_job_get',
    description: '岗位详情：字段全量 + 来源证据 + 状态变更历史 + 匹配解释 + 关联投递。解读岗位前用它。',
    params: { id: S('岗位 id') },
    required: ['id'],
    handler: (args) => {
      const job = repos.jobs.getJob(String(args.id))
      if (!job) throw new Error('岗位不存在')
      return { ok: true, job: job, statusLabel: STATUS_LABEL[job.status] }
    },
  }))

  add(makeTool({
    name: 'career_job_verify',
    description: '记录一次招聘状态核验。官方来源（company careers 页面）可把状态改为 OPEN/CLOSED/UPCOMING；非官方来源只能把 UNKNOWN 升为 UNVERIFIED，绝不会确认「仍在招」。历史不会被覆盖。',
    params: {
      id: S('岗位 id'),
      status: S('OPEN/CLOSED/UPCOMING/UNVERIFIED/STALE/UNKNOWN'),
      official: B('该证据是否来自官方招聘页'),
      sourceUrl: S('证据链接'),
      evidence: S('简短证据摘录（原文一句话）'),
      note: S('备注'),
    },
    required: ['id', 'status'],
    handler: (args) => {
      if (!JOB_STATUSES.includes(String(args.status))) throw new Error(`状态必须是 ${JOB_STATUSES.join('/')}`)
      const result = repos.jobs.applyStatusObservation(String(args.id), {
        status: String(args.status),
        official: args.official === true,
        sourceType: args.official ? 'official_careers' : 'manual',
        sourceUrl: args.sourceUrl ?? null,
        evidence: args.evidence ?? null,
        note: args.note ?? null,
      })
      if (args.sourceUrl) repos.jobs.attachSource(String(args.id), {
        sourceType: args.official ? 'official_careers' : 'manual',
        url: String(args.sourceUrl),
        excerpt: args.evidence ?? null,
        verificationStatus: args.official ? 'verified' : 'unverified',
        claimType: args.status === 'CLOSED' ? 'job_closed' : 'job_opening',
      })
      return { ok: true, ...result, note: result.changed ? '状态已更新并写入历史' : '状态未变化' }
    },
  }))

  add(makeTool({
    name: 'career_jobs_sync',
    description: '对已登记的公司官方招聘页做一次增量检查：读 robots.txt → 拉页面 → 对比上次快照 → 变化则生成提醒。合法、串行、有节流。第三方平台不在此列。',
    params: { companyId: S('只检查某家公司（可选）'), autoImport: B('是否把识别到的岗位链接入库为 UNVERIFIED 岗位') },
    async handler(args) {
      const companies = repos.jobs.listCompanies({ limit: 500 }).filter((c) => c.careers_url || c.intern_url)
      const selected = args.companyId ? companies.filter((c) => c.id === args.companyId) : companies
      if (!selected.length) {
        return {
          ok: true, checked: 0,
          note: '还没有登记任何官方招聘页。先用 career_company_upsert 填写 careersUrl（如 https://jobs.bytedance.com/campus），再运行同步。',
        }
      }
      const results = []
      for (const company of selected.slice(0, 12)) {
        const url = company.careers_url || company.intern_url
        let rule = repos.monitor.listRules().find((r) => r.kind === 'careers_page' && r.spec?.url === url)
        if (!rule) {
          rule = repos.monitor.createRule({
            name: `${company.name} 招聘页`, kind: 'careers_page',
            spec: { url, company: company.name, autoImport: args.autoImport === true },
          })
        }
        results.push({ company: company.name, ...(await monitor.runRule(rule.id)) })
      }
      return { ok: true, checked: results.length, results, note: '只对比页面结构变化与在招信号，不抓取登录后内容。' }
    },
  }))

  add(makeTool({
    name: 'career_jobs_crawl',
    description: '爬取公开岗位列表页并入库，自动带出岗位标题、工作地点、投递地址、截止日期、技能与招聘类型（秋招/春招/暑期）。优先用 schema.org JobPosting(JSON-LD)，其次页面内嵌 JSON，最后链接聚类。遵守 robots.txt、串行节流、只读公开页面。纯前端渲染(SPA)页面抓不到岗位结构时会在 warnings 里直说，不会编造岗位。',
    params: {
      urls: SA('一个或多个岗位列表页 URL（优先官方校招/社招页面）'),
      company: S('公司名；页面能解析出公司时以页面为准'),
      official: B('是否官方招聘页，默认 true；决定能否把状态标为「官方确认在招」'),
      recruitType: S(RECRUIT_TYPES.join('|') + '；留空自动判断'),
      maxDetail: N('为前 N 个岗位抓详情页补全 JD（默认 0，上限 20，每页串行）'),
      dryRun: B('只抓取并预览、不入库，默认 false'),
    },
    required: ['urls'],
    async handler(args) {
      const urls = arr(args.urls).slice(0, 8)
      if (!urls.length) throw new Error('需要至少一个 url')
      const official = args.official !== false
      const recruitType = args.recruitType ? String(args.recruitType) : null
      const runId = repos.monitor.startRun('crawl', urls.join(' '))
      const pages = []
      let created = 0
      let merged = 0
      let fetched = 0
      const failures = []

      for (const url of urls) {
        // A recognised ATS gets its official read-only API first — it is both the
        // most reliable path and the one that yields full location/apply URLs.
        const detected = detectAts(url)
        let page = null
        let usedAts = null
        if (detected) {
          const atsRes = await fetchAtsPostings({ ats: detected.ats, token: detected.token, timeoutMs: config.httpTimeoutMs })
          if (atsRes.ok) {
            usedAts = { ats: detected.ats, label: detected.spec.label, token: detected.token, apiUrl: atsRes.apiUrl }
            page = {
              ok: true,
              url: atsRes.apiUrl,
              strategy: `ats:${detected.ats}`,
              postings: atsRes.postings,
              warnings: [`通过 ${detected.spec.label} 公开只读接口读取（无需登录）。`],
              signals: { open: true },
            }
          } else {
            page = await crawlListing(url, {
              timeoutMs: config.httpTimeoutMs,
              gapMs: config.httpGapMs,
              maxDetail: Number(args.maxDetail ?? 0),
            })
            page.warnings = [...(page.warnings ?? []), `先试了 ${detected.spec.label} 接口但失败：${atsRes.error}`]
          }
        } else {
          page = await crawlListing(url, {
            timeoutMs: config.httpTimeoutMs,
            gapMs: config.httpGapMs,
            maxDetail: Number(args.maxDetail ?? 0),
          })
        }
        fetched += page.postings?.length ?? 0
        if (!page.ok) {
          failures.push({ url, error: page.error })
          pages.push({
            url, ok: false, error: page.error, postings: [],
            guide: guideInline({ company: args.company, url }),
          })
          continue
        }
        const normalized = page.postings.map((posting) => postingToJob(posting, { company: args.company, pageUrl: page.url }))
        // A page we could not turn into postings still owes the user exact next steps.
        const guide = page.strategy === 'none'
          ? guideInline({ company: args.company, url })
          : null
        if (args.dryRun === true) {
          pages.push({
            url: page.url, ok: true, strategy: page.strategy, count: normalized.length,
            warnings: page.warnings, signals: page.signals, ats: usedAts, guide,
            preview: normalized.slice(0, 60).map((j) => ({
              title: j.title, company: j.company, location: j.location,
              recruitType: j.recruitType, deadline: j.deadline, applyUrl: j.applyUrl,
              skills: (j.skills ?? []).slice(0, 6),
            })),
          })
          continue
        }
        const imported = repos.jobs.importPostings(normalized, {
          company: args.company,
          pageUrl: page.url,
          official,
          recruitType,
          sourceName: official ? '官方招聘页（爬取）' : '第三方页面（爬取）',
        })
        created += imported.created.length
        merged += imported.merged.length
        for (const f of imported.failed) failures.push({ url: page.url, error: f.error, title: f.title })
        pages.push({
          url: page.url, ok: true, strategy: page.strategy, count: normalized.length,
          created: imported.created.length, merged: imported.merged.length,
          warnings: page.warnings, signals: page.signals, ats: usedAts, guide,
          sample: normalized.slice(0, 10).map((j) => ({ title: j.title, location: j.location, applyUrl: j.applyUrl })),
        })
      }

      const status = failures.length && !created && !merged ? 'error' : 'ok'
      repos.monitor.finishRun(runId, {
        status,
        fetched,
        inserted: created,
        updated: merged,
        error: failures.length ? failures.slice(0, 3).map((f) => `${f.url}: ${f.error}`).join(' | ') : null,
        meta: { urls: urls.length, strategy: pages.map((p) => p.strategy ?? null) },
      })
      repos.monitor.recordSourceResult(official ? 'official_careers' : 'job_board', {
        ok: status === 'ok', error: failures[0]?.error, fetched, inserted: created, official: official ? created : 0,
      })
      return {
        ok: status === 'ok',
        dryRun: args.dryRun === true,
        pages,
        totals: { pages: urls.length, fetched, created, merged, failed: failures.length },
        failures: failures.slice(0, 10),
        policy: '只抓取 robots.txt 允许的公开页面；不登录、不带 Cookie、不绕过任何访问控制。',
        next: args.dryRun === true
          ? '把 preview 给用户确认后再用 dryRun=false 入库。'
          : '入库后用 career_match_rank 重算排序；投递地址见每条 applyUrl。',
      }
    },
  }))

  // 响应体 → 岗位列表。curl 重放与浏览器抓取共用这套识别。
  const extractPostingsFromPayload = (payload, sourceUrl) => {
    const atsInfo = detectAts(sourceUrl ?? '')
    let postings = []
    let strategy = 'generic'
    if (atsInfo?.ats) {
      postings = normalizeAtsPayload(atsInfo.ats, payload) ?? []
      if (postings.length) strategy = `ats:${atsInfo.ats}`
    }
    if (!postings.length && payload) {
      for (const candidate of Object.keys(ATS_SPECS)) {
        if (candidate === atsInfo?.ats) continue
        const attempt = normalizeAtsPayload(candidate, payload) ?? []
        if (attempt.length) {
          postings = attempt
          strategy = `ats-guess:${candidate}`
          break
        }
      }
    }
    if (!postings.length) {
      postings = walkJsonForPostings(payload, sourceUrl ?? '')
      strategy = postings.length ? 'json-walk' : 'none'
    }
    return { postings, strategy }
  }

  add(makeTool({
    name: 'career_jobs_from_curl',
    description: '从你自己浏览器里的请求取岗位：把 DevTools「Copy as cURL」粘进来（或直接粘接口返回的 JSON），系统重放一次并解析成岗位入库。这是绕过 SPA 私有接口最可靠的办法——不破解签名、不绕过登录，只重放你被授权的那一次请求。响应里没有岗位时会告诉你 JSON 结构，方便换一个请求再试。',
    params: {
      curl: S('DevTools 里 Copy as cURL 得到的整条命令（bash 或 cmd 均可）'),
      json: S('或者直接粘接口返回的 JSON 文本（不做网络请求）'),
      url: S('或者手填：请求地址'),
      method: S('GET/POST，默认按是否有 body 推断'),
      headers: { type: 'object', description: '手填时的请求头（含 Cookie 才带登录态）' },
      body: S('手填时的请求体（POST 查询接口常用 JSON）'),
      company: S('公司名（缺省从响应或你给的地址推断）'),
      recruitType: S('autumn_campus|spring_campus|summer|daily|other'),
      official: B('是否标记为官方核验（默认 false）。false 时写 UNVERIFIED，不会假扮「官方在招」'),
      dryRun: B('只预览不写库，默认 false'),
      limit: N('最多导入多少条，默认 200'),
    },
    async handler(args) {
      const limit = Math.min(Number(args.limit ?? 200), 1000)
      let payload = null
      let sourceUrl = null
      let via = null
      let replayInfo = null

      if (args.json) {
        try {
          payload = JSON.parse(String(args.json))
        } catch (err) {
          return { ok: false, error: `粘贴的 JSON 解析失败：${String(err?.message ?? err)}`, next: '确认复制的是响应体（Response 标签页里的原始 JSON），不是整个 HTML 页面。' }
        }
        via = 'pasted-json'
        sourceUrl = str(args.url, 1000) ?? null
      } else {
        let request = null
        if (args.curl) {
          const parsed = parseCurl(String(args.curl))
          if (!parsed.ok) {
            return {
              ok: false,
              stage: 'parse',
              problems: parsed.problems,
              next: '在 Chrome/Edge 的 Network 面板里右键目标请求 → Copy → Copy as cURL (bash)，整条粘进来。',
            }
          }
          request = { url: parsed.url, method: parsed.method, headers: parsed.headers, body: parsed.body }
          replayInfo = { warnings: parsed.warnings }
        } else if (args.url) {
          request = {
            url: String(args.url),
            method: String(args.method ?? (args.body ? 'POST' : 'GET')).toUpperCase(),
            headers: args.headers && typeof args.headers === 'object' ? args.headers : {},
            body: args.body ? String(args.body) : null,
          }
        } else {
          throw new Error('需要 curl / json / url 三者之一')
        }

        const guard = assertReplayable(request)
        if (!guard.ok) return { ok: false, stage: 'guard', problems: guard.problems }

        const result = await replayRequest(request, { timeoutMs: config.httpTimeoutMs })
        if (!result.ok && result.json === null) {
          return {
            ok: false,
            stage: 'replay',
            status: result.status,
            error: result.error ?? `HTTP ${result.status}`,
            contentType: result.contentType,
            textPreview: result.textPreview,
            next: result.status === 401 || result.status === 403
              ? '接口拒绝了这次请求：多半是缺登录态或签名。请确认在浏览器里已登录，并重新 Copy as cURL（把 Cookie 一起带上）。'
              : '这个地址返回的不是 JSON。请在 Network 里找 Type 为 xhr/fetch、返回岗位列表的那个请求。',
          }
        }
        payload = result.json
        sourceUrl = result.url ?? request.url
        via = args.curl ? 'curl-replay' : 'direct-request'
        replayInfo = { status: result.status, contentType: result.contentType, bytes: result.bytes, headersRedacted: result.headersRedacted, warnings: replayInfo?.warnings ?? [] }
        if (payload === null) {
          return {
            ok: false,
            stage: 'not-json',
            status: result.status,
            contentType: result.contentType,
            textPreview: result.textPreview,
            next: '这次响应不是 JSON。换一个请求：Network 面板里筛 Fetch/XHR，点开看 Preview 是 JSON 数组/对象的那个。',
          }
        }
      }

      // 先按已知 ATS 结构归一，再退回通用「岗位数组」识别。
      const { postings, strategy } = extractPostingsFromPayload(payload, sourceUrl)

      if (!postings.length) {
        return {
          ok: false,
          stage: 'no-postings',
          strategy: 'none',
          responseShape: describeJsonShape(payload),
          topLevelKeys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).slice(0, 20) : null,
          next: '这个响应里没识别出岗位列表——很可能抓到了配置/字典接口。判断方法：看 Preview 里有没有一个数组，里面每项都带「职位名称/岗位名」和「城市/地点」。有的话把那条请求的 cURL 给我。',
        }
      }

      const company = str(args.company, 200) ?? null
      const recruitType = str(args.recruitType, 40) ?? null
      const normalized = postings.slice(0, limit).map((posting) => postingToJob(posting, { company, pageUrl: sourceUrl }))
      const withCompany = normalized.filter((job) => job.title)
      const preview = withCompany.slice(0, 60).map((job) => ({
        title: job.title, company: job.company, location: job.location,
        recruitType: job.recruitType, applyUrl: job.applyUrl, deadline: job.deadline,
      }))

      if (args.dryRun === true) {
        return { ok: true, via, strategy, sourceUrl, found: postings.length, parsed: withCompany.length, replay: replayInfo, preview, next: '确认无误后去掉 dryRun 再跑一次即可入库。' }
      }

      const imported = repos.jobs.importPostings(withCompany, {
        company,
        pageUrl: sourceUrl,
        // 用户重放的接口响应默认不是「官方核验」——一次重放≠官网页面确认。
        // 只有显式 official:true 才升 OPEN；否则一律 UNVERIFIED，可后续 career_job_verify 升级。
        official: args.official === true,
        recruitType,
        sourceName: args.official === true ? '用户重放的接口响应（标记为官方）' : '用户重放的接口响应（未核验）',
      })
      panel.publish({ kind: 'jobs' })
      return {
        ok: true,
        via, strategy, sourceUrl,
        found: postings.length,
        parsed: withCompany.length,
        created: imported.created.length,
        merged: imported.merged.length,
        failed: imported.failed.slice(0, 10),
        replay: replayInfo,
        sample: preview.slice(0, 10),
        note: '这批岗位的来源记为用户重放的接口响应，状态为 UNVERIFIED（不是官网页面直采），需要时可再用 career_job_verify 升级。',
      }
    },
  }))

  // ── 专用浏览器：登录一次，之后自动抓 ──────────────────────────────────────
  add(makeTool({
    name: 'career_browser_login',
    description: '打开「专用浏览器」让你登录目标站点（字节/腾讯/学校就业网等）。这个窗口有独立 profile（存在 data/browser-profile），登录资料跨重启保留；站点失效时仍需重新登录。注意：不能用 DSH 内置浏览器——那是沙箱 webview，插件读不到页面。',
    params: {
      url: S('要打开并登录的网址，如 https://jobs.bytedance.com/campus'),
      site: S('或直接给站点：xhs | boss | 51job | offershow | nowcoder（自动取登录页）'),
    },
    handler: async (args) => {
      const url = str(args.url, 2000) ?? loginUrlForConnector(str(args.site, 40)) ?? (getSiteProfile(args.site)?.loginUrl) ?? null
      if (!url) throw new Error('需要 url 或受支持的 site（xhs/boss/51job/offershow）')
      const result = await openForLogin({ dataDir: config.dataDir, url, logger })
      return {
        ...result,
        executable: findBrowserExecutable(),
        next: result.ok
          ? '请在弹出的浏览器窗口里完成登录，然后回来告诉我，我用 career_browser_capture 抓岗位。'
          : '没有可用浏览器：请安装 Microsoft Edge 或 Google Chrome。',
      }
    },
  }))

  add(makeTool({
    name: 'career_browser_capture',
    description: '用专用浏览器打开一个岗位页，自动捕获它自己发出的 JSON 响应并解析成岗位入库。前提是该站点已通过 career_browser_login 登录过。不需要 F12、不需要复制 cURL。',
    params: {
      url: S('岗位列表页地址（必填）'),
      patterns: SA('判断「哪个响应像岗位列表」的关键词，默认 job/post/position/search/campus/recruit'),
      company: S('公司名（缺省从页面推断）'),
      recruitType: S('autumn_campus|spring_campus|summer|daily|other'),
      official: B('是否标记为官方核验（默认 false）。false 时写 UNVERIFIED，不会假扮「官方在招」'),
      dryRun: B('只预览不写库，默认 false'),
      limit: N('最多导入多少条，默认 200'),
      timeoutMs: N('等待页面加载与请求的毫秒数，默认 25000'),
      scope: S('这次抓取的筛选范围描述，如「岗位类别=产品;城市=北京,上海;招聘类型=暑期实习」。范围一致的两次抓取才能判定「下架」'),
      useOpenTab: B('从你已经打开的同源标签页抓（会重载该页触发请求）。不知道岗位列表在哪条路由时用这个'),
      fillJd: B('抓完列表后自动补 JD 正文（默认 true）。列表接口不给正文的站点（如腾讯）靠这一步才有描述'),
    },
    required: ['url'],
    handler: async (args) => {
      const targetUrl = String(args.url)
      const captured = await capturePageJson({
        dataDir: config.dataDir,
        url: targetUrl,
        matchUrl: args.useOpenTab === true ? targetUrl : undefined,
        patterns: arr(args.patterns).length ? arr(args.patterns).map(String) : undefined,
        timeoutMs: Math.min(Number(args.timeoutMs ?? 25000), 60000),
        logger,
      })
      if (!captured.ok) {
        return {
          ok: false,
          error: captured.error,
          candidates: captured.candidates ?? [],
          next: /登录|login/i.test(String(captured.error))
            ? '这个站点需要登录：先跑 career_browser_login 打开并登录一次。'
            : (captured.candidates ?? []).length
              ? '页面发出的 JSON 都不像岗位列表。看 candidates 里的地址，用 career_jobs_from_curl 手动指定其中一条。'
              : '页面没发出任何 JSON 请求：可能列表是服务端渲染，改用 career_jobs_crawl 直接抓 HTML。',
        }
      }

      const sourceUrl = captured.captured.url
      const { postings, strategy } = extractPostingsFromPayload(captured.captured.json, sourceUrl)
      if (!postings.length) {
        return {
          ok: false,
          stage: 'no-postings',
          capturedUrl: sourceUrl,
          responseShape: describeJsonShape(captured.captured.json),
          candidates: captured.candidates,
          next: '抓到的响应里没有岗位列表——看 responseShape 判断是不是配置接口，或用 candidates 换一条。',
        }
      }

      const requestedLimit = Number(args.limit ?? 200)
      const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(Math.floor(requestedLimit), 1000)) : 200
      const company = str(args.company, 200) ?? null
      const normalized = postings.slice(0, limit).map((posting) => postingToJob(posting, { company, pageUrl: sourceUrl }))
      // 调用方显式给了批次就以它为准（用户就是按这个筛选抓的），
      // 不能让正文里的一句「2027校园招聘」把实习生岗位标成秋招。
      const explicitRecruitType = str(args.recruitType, 40) ?? null
      const withCompany = normalized
        .filter((job) => job.title)
        .map((job) => ({ ...job, recruitType: explicitRecruitType ?? job.recruitType ?? null }))
      const preview = withCompany.slice(0, 60).map((job) => ({
        title: job.title, company: job.company, location: job.location,
        recruitType: job.recruitType, applyUrl: job.applyUrl, deadline: job.deadline,
      }))

      if (args.dryRun === true) {
        return { ok: true, mode: 'browser', strategy, sourceUrl, found: postings.length, parsed: withCompany.length, preview, candidates: captured.candidates, next: '确认后去掉 dryRun 再跑一次入库。' }
      }

      // ── 抓取留痕：抓之前的现场（用于 diff），抓完再落库 ──
      const companyName = company ?? withCompany[0]?.company ?? null
      const ckey = companyKey(companyName ?? '')
      const scopeKey = scopeKeyOf(args.scope ?? null)
      const reportedTotal = extractReportedTotal(captured.captured.json)
      const previousCapture = ckey ? repos.captures.latest(ckey, scopeKey) : null
      const freshness = captureFreshness(previousCapture?.captured_at ?? null)
      const beforeJobs = ckey ? repos.captures.currentJobs(companyName, ckey) : []
      const previousJd = ckey ? repos.captures.previousJdSnapshots(ckey) : []

      const imported = repos.jobs.importPostings(withCompany, {
        company: companyName,
        pageUrl: sourceUrl,
        // 自动捕获 ≠ 官方核验：默认 UNVERIFIED，避免「抓了一次就当官方在招」误导。
        official: args.official === true,
        recruitType: str(args.recruitType, 40) ?? null,
        sourceName: args.official === true ? '专用浏览器捕获（标记为官方）' : '专用浏览器捕获（未核验）',
      })
      panel.publish({ kind: 'jobs' })

      // 两次抓取的集合差异：新增 / 下架。
      // 基准是「上一次同范围抓取看到的编号集合」，不是整个公司岗位库——
      // 否则换个筛选范围再抓，就会把别的批次的岗位全报成下架。
      // 只把本次成功入库的不同岗位作为观察集合；不能把 limit 之前的总条数或失败行当已抓全。
      const batchJobs = [...new Set([...imported.created, ...imported.merged])]
        .map((id) => repos.jobs.getJob(id)).filter(Boolean)
      const batchRows = batchJobs.map((job) => ({
        jobCode: job.job_code ?? null,
        title: job.title,
        location: job.location,
      }))
      const parseWarnings = (imported.failed ?? []).map((failure) => String(failure.error ?? failure.title ?? '入库失败'))
      if (withCompany.length < normalized.length) parseWarnings.push(`缺失标题，跳过 ${normalized.length - withCompany.length} 条。`)
      const missingCodes = batchRows.filter((row) => !row.jobCode).length
      if (missingCodes) parseWarnings.push(`${missingCodes} 条成功岗位缺少编号，编号基线不完整。`)
      const completeness = repos.captures.assessCompleteness({
        reportedTotal,
        extractedCount: postings.length,
        batchCount: normalized.length,
        observedCount: batchRows.length,
        failedCount: imported.failed?.length ?? 0,
        parseWarnings,
        // 这里只处理捕获的网络 JSON；截图/列表可见文本不得声明 API 已全量。
        evidenceKind: 'api-json',
      })
      const prevCodes = Array.isArray(previousCapture?.seenCodes) ? previousCapture.seenCodes : null
      const hasBaseline = Boolean(previousCapture && prevCodes)
      const prevRows = hasBaseline
        ? prevCodes.map((code) => {
          const hit = beforeJobs.find((row) => String(row.jobCode) === String(code))
          return { jobCode: code, title: hit?.title ?? '', location: hit?.location ?? '', companyKey: ckey }
        })
        : []
      const setDiff = hasBaseline
        ? diffCaptures({
          previous: prevRows,
          current: batchRows.map((row) => ({ ...row, companyKey: ckey })),
          previousScopeKey: previousCapture.scope_key,
          currentScopeKey: scopeKey,
          // 旧版本 is_complete 未检查 limit/失败；没有校验明细的历史记录按未知处理。
          previousCompleteness: previousCapture.stats?.completeness
            ? { ...previousCapture.stats.completeness, isComplete: previousCapture.isComplete === true && previousCapture.stats.completeness.isComplete === true, parseWarnings: previousCapture.parseWarnings }
            : null,
          currentCompleteness: completeness,
        })
        : null

      // JD 快照：先取旧值做内容比对，再写新值
      let jdChanges = []
      let savedSnapshots = 0
      if (ckey) {
        const codeMap = repos.captures.jobIdByCode(companyName, batchRows.map((row) => row.jobCode))
        const rowsForSnapshot = []
        normalized.forEach((job) => {
          const code = job.jobCode
          const jobId = code && batchRows.some((row) => String(row.jobCode) === String(code)) ? codeMap.get(String(code)) : null
          if (!jobId) return
          rowsForSnapshot.push({
            jobId, companyKey: ckey, title: job.title, location: job.location,
            deadline: job.deadline ?? null, description: job.description ?? null, requirements: job.requirements ?? null,
          })
        })
        jdChanges = diffJdSnapshots({ before: previousJd, after: rowsForSnapshot.map((row) => ({ ...row, jobId: row.jobId })) })
        savedSnapshots = repos.captures.saveJdSnapshots(rowsForSnapshot).saved
        repos.captures.record({
          companyKey: ckey,
          companyName,
          sourceUrl,
          scope: str(args.scope, 500) ?? null,
          scopeKey,
          found: postings.length,
          created: imported.created.length,
          merged: imported.merged.length,
          seenCodes: batchRows.map((row) => row.jobCode).filter(Boolean),
          // 完整性须基于 limit 后实际成功记录数，并保留校验证据供下次 diff 使用。
          reportedTotal,
          observedCount: batchRows.length,
          isComplete: completeness.isComplete,
          parseWarnings: completeness.parseWarnings,
          stats: { strategy, parsed: withCompany.length, failed: imported.failed?.length ?? 0, jdSnapshots: savedSnapshots, completeness },
          note: 'career_browser_capture',
        })
      }

      // 自动补 JD 正文：列表接口常常不返回正文（腾讯就是这样），
      // 抓完列表立刻按 postId 逐条调详情接口补上，免得岗位库里只有标题。
      let jdFill = null
      if (args.fillJd !== false) {
        const codes = batchRows.map((r) => r.jobCode).filter(Boolean)
        const idMap = ckey ? repos.captures.jobIdByCode(companyName, codes) : new Map()
        const targets = []
        for (const code of codes) {
          const jobId = idMap.get(String(code))
          if (!jobId) continue
          const job = repos.jobs.getJob(jobId)
          if (job && !String(job.description ?? '').trim()) targets.push(job)
        }
        const filled = []
        const failed = []
        for (const job of targets.slice(0, 60)) {
          const provider = resolveJdProvider({ applyUrl: job.apply_url, url: job.url })
          if (!provider) { failed.push({ title: job.title, error: '这家公司没登记详情接口' }); continue }
          const res = await fetchJdDetail({ provider, postId: job.post_id, jobCode: job.job_code, url: job.apply_url ?? job.url, dataDir: config.dataDir, timeoutMs: config.httpTimeoutMs })
          if (!res.ok) { failed.push({ title: job.title, error: res.error }); continue }
          const w = repos.jobs.setJd(job.id, res)
          if (w?.updated) {
            repos.captures.saveJdSnapshots([{ jobId: job.id, companyKey: ckey, title: job.title, location: res.location ?? job.location, deadline: job.deadline, description: res.description ?? job.description, requirements: res.requirements ?? job.requirements }])
            filled.push({ title: job.title, chars: (res.description ?? '').length })
          }
        }
        jdFill = { attempted: targets.length, filled: filled.length, sample: filled.slice(0, 5), failed: failed.slice(0, 8) }
      }

      return {
        ok: true,
        mode: 'browser',
        strategy,
        sourceUrl,
        found: postings.length,
        parsed: withCompany.length,
        created: imported.created.length,
        merged: imported.merged.length,
        failed: imported.failed.slice(0, 10),
        sample: preview.slice(0, 10),
        jdFill,
        completeness,
        freshness: {
          previousCaptureAt: previousCapture?.captured_at ?? null,
          previousScope: previousCapture?.scope ?? null,
          ...freshness,
        },
        diff: setDiff
          ? {
            added: setDiff.added.slice(0, 40),
            removed: setDiff.removed.slice(0, 40),
            addedCount: setDiff.added.length,
            removedCount: setDiff.removed.length,
            unchanged: setDiff.unchanged,
            scopesComparable: setDiff.scopesComparable,
            vanishedButNotClosed: setDiff.vanishedButNotClosed.slice(0, 40),
            vanishedButNotClosedCount: setDiff.vanishedButNotClosed.length,
            reason: setDiff.reason,
            caveat: setDiff.caveat,
          }
          : {
            addedCount: 0,
            removedCount: 0,
            seenCount: batchRows.length,
            scopesComparable: false,
            caveat: previousCapture
              ? `上次抓取（范围「${previousCapture.scope ?? '全部'}」）没有记录岗位编号明细，无法可靠判定下架；本次成功记录 ${batchRows.length} 条并建立观察基线，仅前后同范围且均证实完整时才报下架。`
              : `这是「${args.scope ?? '全部'}」范围的首次抓取，本次成功记录 ${batchRows.length} 条并建立观察基线，仅前后同范围且均证实完整时才报下架。`,
          },
        jdChanges: jdChanges.slice(0, 30),
        jdSnapshotsSaved: savedSnapshots,
        next: setDiff?.vanishedButNotClosed.length
          ? `本次新增 ${setDiff.added.length} 条，另有 ${setDiff.vanishedButNotClosed.length} 条本次未见，完整性或范围证据不足，不能判下架；需补全抓取或官网复核。`
          : setDiff && (setDiff.added.length || setDiff.removed.length)
            ? `本次变化：新增 ${setDiff.added.length} 条、下架 ${setDiff.removed.length} 条。可以让我针对新增岗位做匹配排序。`
            : (setDiff ? (setDiff.reason ? '本次观察集合无变化，但抓取完整性未证实，不能确认全量岗位无变化。' : '与上次相比没有变化。') : '已建立该范围的观察基线；仅前后均证实完整的同范围抓取可用于判定下架。'),
        note: '来源记为「专用浏览器自动捕获」，状态 UNVERIFIED（不是官网页面直采）；需要时可 career_job_verify 升级。',
      }
    },
  }))

  add(makeTool({
    name: 'career_browser_close',
    description: '关闭专用浏览器。登录态（profile）会保留，下次不用重新登录。',
    params: {},
    handler: async () => ({ ...(await closeBrowser({ dataDir: config.dataDir, logger })), profileDir: browserProfileDir(config.dataDir), note: 'profile 已保留，登录态不会丢。' }),
  }))

  // ── 公司 → 校招官网 ────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_campus_portal',
    description: '说一家公司，给出它的校招官网地址：本地内置候选项，现场探测哪个真能打开（不凭记忆断言 URL 可用）。拿到地址后用 career_browser_login 登录、再用 career_browser_capture 抓岗位。',
    params: {
      company: S('公司名，如 腾讯 / 字节跳动 / 鹅厂'),
      probe: B('是否现场探测候选地址，默认 true'),
    },
    required: ['company'],
    handler: async (args) => {
      const name = String(args.company)
      const portal = resolvePortal(name)
      if (!portal) {
        return {
          ok: false,
          company: name,
          reason: '内置清单里没有这家公司（我不是靠记忆瞎给 URL）',
          next: [
            `1) 你自己搜「${name} 校园招聘」进官网，把地址发给我；`,
            '2) 我用 career_browser_login 打开、你登录；',
            '3) 我用 career_browser_capture 抓。',
            `（要我把「${name}」加进内置清单也可以，给我一次确认过的地址即可。）`,
          ].join('\n'),
        }
      }
      const probe = args.probe === false ? null : await probePortals(portal, { timeoutMs: 12000 })
      const best = probe?.best ?? portal.urls?.[0] ?? null
      return {
        ok: Boolean(best),
        company: portal.name,
        matchedBy: name,
        campusUrl: best,
        candidates: probe?.results ?? portal.urls.map((url) => ({ url, ok: null, note: '未探测' })),
        reachable: probe?.reachable ?? null,
        apiHint: portal.apiHint ?? null,
        verifiedBy: portal.verifiedBy ?? null,
        next: best
          ? `下一步：career_browser_login {url:"${best}"} → 你在窗口里登录 → career_browser_capture {url:"${best}", company:"${portal.name}"}`
          : '候选地址都打不开：可能改版或被网络限制。把你在浏览器里能打开的校招地址发我，我直接用它。',
        caveat: '校招站点会改版改地址；这里给的是候选 + 现场探测结果，不是永久承诺。',
      }
    },
  }))

  add(makeTool({
    name: 'career_capture_status',
    description: `${STALE_DAYS} 天过期规则的状态视图：某家公司上次什么时候抓的、抓了多少、用的什么筛选范围，是否该重抓；并列出历次抓取记录。`,
    params: {
      company: S('公司名（可选，不传则列出全部公司）'),
      limit: N('历史记录条数，默认 10'),
    },
    handler: (args) => {
      const limit = Math.min(Number(args.limit ?? 10), 50)
      if (args.company) {
        const name = String(args.company)
        const key = companyKey(name)
        const latest = repos.captures.latest(key)
        const freshness = captureFreshness(latest?.captured_at ?? null)
        return {
          ok: true,
          company: name,
          companyKey: key,
          lastCapturedAt: latest?.captured_at ?? null,
          lastScope: latest?.scope ?? null,
          lastFound: latest?.found ?? 0,
          completeness: latest
            ? {
              reportedTotal: latest.reported_total ?? null,
              observed: latest.observed_count ?? latest.found ?? 0,
              isComplete: latest.is_complete === null || latest.is_complete === undefined ? null : Boolean(latest.is_complete),
              parseWarnings: latest.parseWarnings ?? [],
            }
            : null,
          freshness,
          stale: freshness.stale,
          history: repos.captures.history(key, limit),
          inLibrary: repos.captures.currentJobs(name, key).length,
          next: freshness.stale
            ? `数据已过期（${freshness.reason}）：重新抓一次会做 diff，报告新增/下架/JD 改动。`
            : `数据还新鲜（${freshness.reason}），${freshness.dueAt?.slice(0, 10)} 之后再来。`,
        }
      }
      const rows = repos.db.all(
        `SELECT company_key, company_name, max(captured_at) AS captured_at, count(*) AS runs, max(found) AS max_found
         FROM company_capture GROUP BY company_key ORDER BY captured_at DESC LIMIT ?`, [limit])
      return {
        ok: true,
        thresholdDays: STALE_DAYS,
        companies: rows.map((row) => ({
          company: row.company_name ?? row.company_key,
          capturedAt: row.captured_at,
          runs: row.runs,
          ...captureFreshness(row.captured_at),
        })),
        note: rows.length ? undefined : '还没有任何抓取记录。',
      }
    },
  }))

  add(makeTool({
    name: 'career_job_jd_fetch',
    description: '按需补全 JD 正文：有些站点（如腾讯校招）的列表接口只返回标题和地点，正文要另调详情接口。这个工具对「缺 JD 正文」的岗位逐个调详情接口并写回，同时存 JD 快照。认不出的站点会诚实说明不支持的接口。',
    params: {
      company: S('只补这家公司的岗位（可选）'),
      ids: SA('只补这几个岗位 id（可选，优先于 company）'),
      limit: N('最多补多少条，默认 50'),
    },
    handler: async (args) => {
      const limit = Math.min(Number(args.limit ?? 50), 300)
      let targets = []
      if (arr(args.ids).length) {
        targets = arr(args.ids).map((id) => repos.jobs.getJob(String(id))).filter(Boolean)
      } else {
        targets = repos.jobs.jobsMissingJd({ company: str(args.company, 200) ?? undefined, limit })
      }
      if (!targets.length) {
        return { ok: true, total: 0, note: '没有缺 JD 正文的岗位。' }
      }

      const filled = []
      const skipped = []
      const failed = []
      for (const job of targets.slice(0, limit)) {
        const provider = resolveJdProvider({ applyUrl: job.apply_url, url: job.url })
        if (!provider) {
          skipped.push({ id: job.id, company: job.company_name, title: job.title, reason: '这家公司的详情接口没有登记' })
          continue
        }
        const result = await fetchJdDetail({ provider, postId: job.post_id, jobCode: job.job_code, url: job.apply_url ?? job.url, dataDir: config.dataDir, timeoutMs: config.httpTimeoutMs })
        if (!result.ok) {
          failed.push({ id: job.id, company: job.company_name, title: job.title, error: result.error })
          continue
        }
        const written = repos.jobs.setJd(job.id, result)
        if (written?.updated) {
          repos.captures.saveJdSnapshots([{
            jobId: job.id,
            companyKey: companyKey(job.company_name ?? ''),
            title: job.title,
            location: result.location ?? job.location,
            deadline: job.deadline,
            description: result.description ?? job.description,
            requirements: result.requirements ?? job.requirements,
          }])
          filled.push({ id: job.id, company: job.company_name, title: job.title, filled: written.filled, chars: (result.description ?? '').length })
        } else {
          skipped.push({ id: job.id, company: job.company_name, title: job.title, reason: '已有正文，未覆盖' })
        }
      }
      panel.publish({ kind: 'jobs' })
      return {
        ok: true,
        total: targets.length,
        filled: filled.length,
        skipped: skipped.length,
        failed: failed.length,
        detail: { filled, skipped: skipped.slice(0, 10), failed: failed.slice(0, 10) },
        next: failed.length
          ? '有失败的：多半是缺 postId（重新抓一次列表就会带上）或接口改版。'
          : (filled.length ? 'JD 已写回岗位库，岗位雷达里双击就能看到正文。' : '没有需要补的。'),
      }
    },
  }))

  add(makeTool({
    name: 'career_resume_quality',
    description: '简历质量检查：列出可核对的问题（缺联系方式、教育缺时间、同机构重复、时间倒挂、技能无依据、JD 要求未覆盖等），分 error/warn/info 三档。只报问题，不替你补内容、不评判好坏。',
    params: {
      jobId: S('可选：针对某个岗位检查 JD 覆盖情况'),
    },
    handler: (args) => {
      const job = args.jobId ? repos.jobs.getJob(String(args.jobId)) : null
      const result = checkResumeQuality({
        profile: repos.profile.get(),
        experiences: repos.profile.listExperiences(),
        documents: repos.profile.listDocuments({}),
        job,
      })
      return { ok: true, ...result, targetJob: job ? { id: job.id, company: job.company_name, title: job.title } : null }
    },
  }))

  // ── 高层任务工作流（把原子工具收敛成常用任务）────────────────────────────
  add(makeTool({
    name: 'career_find_jobs',
    description: '高层任务：帮我找适合的岗位。读画像 → 拉岗位池 → 六维匹配 + 硬性资格 → 输出带理由的推荐排序，并标注哪些岗位 JD 不完整（结论可能偏保守）。',
    params: {
      limit: N('返回多少条推荐，默认 10'),
      city: S('只在某个城市里找（可选）'),
      type: S('实习类型过滤：daily/summer/winter/long/short/other（可选）'),
      status: SA('只看这些招聘状态（可选）'),
    },
    handler: (args) => {
      const profile = repos.profile.get()
      const jobs = repos.jobs.listJobs({
        limit: 400,
        location: str(args.city, 100) ?? undefined,
        internshipType: arr(args.type).length ? arr(args.type) : undefined,
        status: arr(args.status).length ? arr(args.status) : undefined,
      }, profile)
      const result = findJobsForMe({ profile, jobs, limit: Number(args.limit ?? 10) })
      return envelope(result, {
        warnings: result.caveats ?? [],
        nextActions: result.ok === false ? ['先填写画像'] : (result.count ? ['对选中的岗位跑 career_prep_resume'] : ['先去岗位雷达抓岗位']),
        meta: { tool: 'career_find_jobs', considered: result.considered ?? 0 },
      })
    },
  }))

  add(makeTool({
    name: 'career_my_progress',
    description: '高层任务：我的投递进展怎么样。汇总投递总数/在流程中、转化漏斗（含卡点）、以及逾期/停滞/有下一步的记录。',
    params: {},
    handler: () => {
      const applications = repos.applications.list({ limit: 1000, includeArchived: false })
      const events = repos.db.all('SELECT * FROM application_event')
      const result = summarizeApplications({ applications, events })
      return envelope(result, {
        warnings: result.funnel?.caveat ? [result.funnel.caveat] : [],
        nextActions: result.needsAction?.length ? ['优先处理 needsAction 里的记录'] : [],
        meta: { tool: 'career_my_progress', total: result.total },
      })
    },
  }))

  add(makeTool({
    name: 'career_prep_resume',
    description: '高层任务：为这个岗位准备简历。先判断 JD 完整性 → 按岗位挑选/排序经历 → 列缺口 → 做质量检查。只出方案，不编造内容、不生成事实。',
    params: {
      jobId: S('目标岗位 id（必填）'),
      maxEntries: N('最多保留几段经历，默认 6'),
      bulletsPerEntry: N('每段最多几条要点，默认 3'),
    },
    required: ['jobId'],
    handler: (args) => {
      const job = repos.jobs.getJob(String(args.jobId))
      if (!job) throw new Error('岗位不存在')
      const result = prepResumeForJob({
        profile: repos.profile.get(),
        experiences: repos.profile.listExperiences(),
        documents: repos.profile.listDocuments({}),
        job,
        maxEntries: Number(args.maxEntries ?? 6),
        bulletsPerEntry: Number(args.bulletsPerEntry ?? 3),
      })
      return envelope(result, {
        warnings: [result.caveat, ...(result.quality?.issues ?? []).filter((i) => i.level === 'error').map((i) => i.message)].filter(Boolean),
        nextActions: ['确认挑选结果后调用 career_resume_build 出稿'],
        meta: { tool: 'career_prep_resume', jdLevel: result.jdCompleteness?.level ?? null },
      })
    },
  }))

  add(makeTool({
    name: 'career_site_capture',
    description: '按站点采集：小红书（笔记/面经）、BOSS直聘、前程无忧（岗位）。用专用浏览器打开你已登录的搜索页，读页面自己发出的 JSON 并解析。首次默认只预览（dryRun=true），确认后再写入。',
    params: {
      site: S('站点：xhs | boss | 51job | offershow | nowcoder'),
      keyword: S('搜索关键词（必填）'),
      city: S('城市（BOSS 用城市码或名称，可选）'),
      url: S('直接给搜索页 URL（可选，优先于自动拼接）'),
      useOpenTab: B('从你已打开的同源标签页抓（会重载），默认 false'),
      dryRun: B('只预览不写库，默认 true（安全）'),
      limit: N('最多导入/预览多少条，默认 30'),
      recruitType: S('只看某类：campus（校招）/ social（社招）/ intern（实习）'),
      fillJd: B('预览或入库时是否抓 JD 正文（默认 true，串行打开详情）'),
      fillJdLimit: N('最多为多少条抓 JD 正文，默认 3（0–20）'),
      fillBody: B('小红书是否进一步读取笔记正文，默认 true'),
      bodyLimit: N('最多补几篇小红书正文，默认 2（0–10）'),
    },
    required: ['site'],
    handler: (args) => captureSite(args, { config, repos, panel, logger }),
  }))

  add(makeTool({
    name: 'career_resume_skill',
    description: '简历优化 skill：列出把杂乱经历包装成 JD 定向简历的方法论（XYZ/STAR/量化/强动词/JD 关键词对齐/科研转译/精简/缺口诚实），并对每条要点给出诊断与改写方向。只诊断不编造。',
    params: {
      jobId: S('目标岗位 id（可选，用它的 JD 做关键词对齐）'),
      jd: S('或直接给 JD 文本'),
      text: S('要诊断的要点（每行一条；不传则用素材库全部要点）'),
      maxSkills: N('最多列几个方法论，默认全部'),
    },
    handler: (args) => {
      const job = args.jobId ? repos.jobs.getJob(String(args.jobId)) : null
      const jdText = str(args.jd, 20000) ?? (job ? [job.description, job.requirements].filter(Boolean).join('\n') : '')
      let bullets
      if (args.text) bullets = String(args.text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      else bullets = repos.profile.listExperiences().flatMap((e) => e.bullets ?? [])
      const analysis = analyzeBullets({ bullets, jdText })
      return {
        ok: true,
        targetJob: job ? { id: job.id, company: job.company_name, title: job.title } : null,
        ...analysis,
        skills: analysis.skills.slice(0, Number(args.maxSkills ?? RESUME_SKILLS.length)),
      }
    },
  }))

  add(makeTool({
    name: 'career_job_research',
    description: '一站调研：读取或搜索JD候选并补正文，采集小红书面经文字与OfferShow校招计划。职位不唯一时返回候选，不擅自认定；薪资未核实绝不把校招计划当薪资。依赖本机专用浏览器登录。',
    params: {
      jobId: S('岗位id'), company: S('公司名'), title: S('岗位名'), keyword: S('面经关键词'),
      includeXhs: B('默认true'), includeOffershow: B('默认true'), useOpenTab: B('复用同源标签页'),
      recruitType: S('campus/social/intern'), site: S('库外JD搜索平台：boss或51job，默认boss'),
    },
    handler: async (args) => {
      let job=args.jobId?repos.jobs.getJob(String(args.jobId)):null
      const company=str(args.company,120)??job?.company_name
      const title=str(args.title,200)??job?.title
      if(!job && !(company && title)) return {ok:false,error:'需要jobId或公司+岗位名'}
      if(!job){const hits=repos.jobs.listJobs({company,limit:300});job=hits.find(j=>j.title===title)??null}
      const result={ok:true,target:{jobId:job?.id??null,company,title},jd:null,xhs:null,offershow:null}
      if(job){
        if(!job.description && !job.requirements){
          const provider=resolveJdProvider({url:job.apply_url??job.url})
          if(provider){
            const detail=await fetchJdDetail({provider,url:job.apply_url??job.url,postId:job.post_id,jobCode:job.job_code,dataDir:config.dataDir,timeoutMs:14000})
            if(detail.ok){repos.jobs.setJd(job.id,detail);job=repos.jobs.getJob(job.id)}
            else result.jdError=detail.error
          }
        }
        result.jd={available:Boolean(job.description||job.requirements),description:job.description,requirements:job.requirements,completeness:jdCompleteness(job),source:'岗位库/岗位详情',status:job.status,location:job.location,applyUrl:job.apply_url}
      }else{
        const candidates=await captureSite({site:args.site==='51job'?'51job':'boss',keyword:[company,title].join(' '),recruitType:args.recruitType,dryRun:true,limit:5,fillJd:true,fillJdLimit:2},{config,repos,panel,logger})
        result.jd={available:false,candidates:candidates.preview??[],search:candidates.search,error:candidates.error,note:'库外返回JD候选；未自动入库或把不同部门岗位当成同一岗位。'}
      }
      if(args.includeXhs!==false){
        result.xhs=await captureSite({site:'xhs',keyword:str(args.keyword,120)??[company,title,'面经'].join(' '),dryRun:true,limit:5,bodyLimit:2,useOpenTab:args.useOpenTab},{config,repos,panel,logger})
      }
      if(args.includeOffershow!==false){
        result.offershow=await captureSite({site:'offershow',keyword:company,dryRun:true,limit:8,fillJd:false,useOpenTab:args.useOpenTab},{config,repos,panel,logger})
        result.offershow.contentKind='recruitment-plan'
        result.offershow.salaryVerified=false
        result.offershow.publicSalaryHighlights=await fetchOfferShowSalaryHighlights({dataDir:config.dataDir,company})
      }
      result.caveats=['论坛内容为用户自述，官方JD与在招状态需独立核实。','搜索仅覆盖当前返回页；无匹配不等于全站没有。','小红书图文可能只有标签，未做OCR的图片/视频不作为已取得面经正文。','OfferShow校招计划不等于薪资爆料，薪资未核实会明确标注。']
      return result
    },
  }))

  add(makeTool({
    name: 'career_source_guide',
    description: '取数指引：告诉用户「这个公司的岗位到底去哪儿拿、复制哪个地址给我」。如果识别出公司用的是 Greenhouse/Lever/Ashby/SmartRecruiters/Workday，直接给出可用的公开接口地址；否则给出精确步骤（打开哪个页面、F12 怎么找返回岗位 JSON 的请求、复制哪一项），以及候选招聘入口和不支持自动采集的平台的检索链接。',
    params: {
      company: S('公司名'),
      url: S('已知的招聘页地址（可选；给了能直接判断是不是标准招聘系统）'),
      role: S('岗位方向（用于生成论坛检索词）'),
      year: N('年份（用于生成检索词）'),
      careersUrl: S('公司档案里登记的招聘入口（可选）'),
    },
    handler: (args) => {
      let careersUrl = args.careersUrl ? String(args.careersUrl) : null
      if (!careersUrl && args.company) {
        const company = repos.jobs.resolveCompany(String(args.company), false)
        if (company?.careers_url) careersUrl = company.careers_url
      }
      const guide = buildRetrievalGuide({
        company: args.company, url: args.url, role: args.role,
        year: args.year, careersUrl,
      })
      return { ok: true, ...guide, atsSpecs: ATS_SPECS }
    },
  }))

  add(makeTool({
    name: 'career_selfcheck',
    description: '环境自检：Python 解释器、PDF 解析依赖（项目内隔离 runtime/pylib）、LaTeX 引擎、Web 搜索/抓取提供方、SQLite、浏览器半是否进入 boot graph。排查「为什么导不进来 / 为什么编译不了 / 为什么搜不到」时先跑它。',
    params: {},
    async handler() {
      const health = await runtimeHealth({ config, db: repos.db, clientHealth: deps.clientHealth, webService: deps.webService })
      const failing = health.checks.filter((c) => !c.done)
      return {
        ...health,
        ok: failing.length === 0,
        failing,
        fixHint: failing.length
          ? '缺 PDF 依赖可调 career_runtime_setup 一键装到项目内；缺 LaTeX 需自行安装 MiKTeX/TeXLive；Web 搜索提供方缺失通常是别的插件没激活。'
          : '全部就绪。',
      }
    },
  }))

  add(makeTool({
    name: 'career_runtime_setup',
    description: '把 PDF 解析依赖（pdfminer.six、pypdf）一键装到项目内的 runtime/pylib（pip --target），不修改用户全局 Python 环境。装完重试导入简历。',
    params: {},
    async handler() {
      const result = await installPdfLibs(config.pythonPath)
      const health = await runtimeHealth({ config, db: repos.db, clientHealth: deps.clientHealth, webService: deps.webService })
      return {
        ok: result.ok,
        ...result,
        pdfLibs: health.pdfLibs,
        next: result.ok ? '已装好，可以直接重新导入 PDF 简历。' : '安装失败：检查网络，或手动运行 node scripts/setup-runtime.mjs',
      }
    },
  }))

  add(makeTool({
    name: 'career_job_delete',
    description: '彻底删除一个岗位（连带它的来源、状态历史、匹配结果、笔记；关联投递会保留但解除绑定）。用于清理测试/演示数据或录错的岗位。',
    params: { id: S('岗位 id'), ids: SA('批量删除：岗位 id 列表') },
    handler: (args) => {
      const list = [...new Set([...(arr(args.ids) ?? []), args.id ? String(args.id) : null].filter(Boolean))]
      if (!list.length) throw new Error('需要 id 或 ids')
      const deleted = list.filter((id) => {
        try {
          return repos.jobs.deleteJob(id)
        } catch (err) {
          logger.warn('job delete failed', { id, error: String(err?.message ?? err) })
          return false
        }
      })
      panel.publish({ kind: 'jobs' })
      return { ok: true, requested: list.length, deleted: deleted.length, ids: deleted }
    },
  }))

  add(makeTool({
    name: 'career_application_delete',
    description: '删除一条投递记录及其时间线。用于清理演示/录错的数据。',
    params: { id: S('投递记录 id') },
    required: ['id'],
    handler: (args) => {
      const ok = repos.applications.delete(String(args.id))
      panel.publish({ kind: 'applications' })
      return { ok, deleted: ok }
    },
  }))

  // ── 简历知识库 / 微调 / LaTeX ──────────────────────────────────────────────
  const uploadDir = path.join(config.dataDir, 'resumes')
  const saveUpload = (fileName, base64) => {
    fs.mkdirSync(uploadDir, { recursive: true })
    const safe = String(fileName ?? 'resume').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'resume'
    const target = path.join(uploadDir, `${Date.now()}-${safe}`)
    fs.writeFileSync(target, Buffer.from(String(base64 ?? ''), 'base64'))
    return target
  }

  add(makeTool({
    name: 'career_resume_upload',
    description: '上传一份简历文件（面板会走 dataBase64；Agent 也可以直接给 path）。自动提取文本、生成解析候选、并可把识别到的经历沉淀进「素材库」。不会覆盖已有画像，确认后才写。',
    params: {
      fileName: S('原始文件名，如 简历-产品.pdf'),
      dataBase64: S('文件内容的 base64（面板上传时用）'),
      path: S('或给本机文件绝对路径'),
      label: S('版本标签'), targetRole: S('该版本针对的岗位'),
      language: S('zh 或 en'),
      seedVault: B('是否把识别到的经历写入素材库，默认 true'),
      setActive: B('是否设为当前版本，默认 true'),
    },
    async handler(args) {
      let filePath = args.path ? String(args.path) : null
      if (!filePath && args.dataBase64) filePath = saveUpload(args.fileName, args.dataBase64)
      if (!filePath) throw new Error('需要 path 或 dataBase64')
      const extracted = await extractResumeText(filePath, { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
      if (!extracted.ok) {
        return {
          ok: false,
          error: extracted.error ?? '简历文本提取失败',
          notes: extracted.notes,
          fallback: '把简历文本粘贴进对话，或用「直接粘贴」导入。',
        }
      }
      const proposal = parseResume(extracted.text, { fileName: args.fileName ?? path.basename(filePath) })
      const resume = repos.profile.addResume({
        label: args.label ?? args.fileName ?? path.basename(filePath),
        targetRole: args.targetRole,
        language: args.language,
        fileName: args.fileName ?? path.basename(filePath),
        filePath,
        mime: extracted.format ?? 'file',
        rawText: extracted.text,
        parsed: proposal,
        parseStatus: 'needs_review',
        parseNotes: [...(extracted.notes ?? []), ...proposal.notes].join('；') || null,
        sourceType: 'upload',
        setActive: args.setActive !== false,
      })
      let seeded = []
      if (args.seedVault !== false) seeded = repos.profile.importExperiencesFromResume(proposal, resume.id)
      panel.publish({ kind: 'resume', resumeId: resume.id })
      return {
        ok: true,
        resumeId: resume.id,
        format: extracted.format,
        chars: extracted.text.length,
        proposal,
        seededExperiences: seeded.length,
        suggestedProfilePatch: proposalToProfilePatch(proposal),
        next: '核对 proposal 与素材库条目（都标了未确认），确认后再写进画像；素材库可以逐条改。',
      }
    },
  }))

  add(makeTool({
    name: 'career_experience_add',
    description: '往「简历素材库」加一条详细经历（实习/项目/科研/校园/奖项/证书）。素材库是唯一事实来源，简历版本只是从这里挑选与排序，所以这里写全、写细，后面微调才有素材可用。',
    params: {
      kind: S('education|internship|project|research|activity|award|certificate|skill'),
      organization: S('公司/学校/项目名'),
      role: S('岗位/角色'),
      startAt: S('开始时间，如 2025-07'), endAt: S('结束时间，如 2025-09'),
      location: S('地点'),
      bullets: SA('要点列表（每条一件事，尽量带真实数字）'),
      tags: SA('标签，如 数据分析、B端'), skills: SA('涉及技能'),
      links: SA('可核验链接（作品/仓库/报道）'),
      evidence: S('可核验说明（没有就留空，不要编）'),
      verified: B('是否已确认属实'),
    },
    required: ['kind'],
    handler: (args) => ({ ok: true, experience: repos.profile.addExperience(args) }),
  }))

  add(makeTool({
    name: 'career_experience_list',
    description: '列出素材库里的全部详细经历（可按 kind 过滤），含每条要点的技能与是否已确认。',
    params: { kind: S('可选：education|internship|project|research|activity|award|certificate|skill') },
    handler: (args) => {
      const experiences = repos.profile.listExperiences({ kind: args.kind })
      const byKind = {}
      for (const exp of experiences) byKind[exp.kind] = (byKind[exp.kind] ?? 0) + 1
      return { ok: true, total: experiences.length, byKind, kindLabels: KIND_LABEL, experiences }
    },
  }))

  add(makeTool({
    name: 'career_experience_update',
    description: '修改素材库里的一条经历（可只改传的字段），或删除。',
    params: {
      id: S('经历 id'), delete: B('设为 true 表示删除'),
      kind: S('类型'), organization: S('公司/学校/项目名'), role: S('岗位/角色'),
      startAt: S('开始时间'), endAt: S('结束时间'), location: S('地点'),
      bullets: SA('要点列表'), tags: SA('标签'), skills: SA('技能'), links: SA('链接'),
      evidence: S('可核验说明'), verified: B('是否已确认'),
    },
    required: ['id'],
    handler: (args) => {
      if (args.delete === true) return { ok: true, deleted: repos.profile.deleteExperience(String(args.id)) }
      return { ok: true, experience: repos.profile.updateExperience(String(args.id), args) }
    },
  }))

  add(makeTool({
    name: 'career_resume_tailor',
    description: '针对某个目标岗位，在素材库基础上生成一版「微调简历」：按岗位关键词挑选与排序经历、精简要点，生成 LaTeX 与纯文本两个版本，并明确列出素材库里没有的缺口。只挑选与排序，不编造任何经历。',
    params: {
      jobId: S('目标岗位 id（必填）'),
      baseVersionId: S('基于哪一版微调（可选；只用于记录谱系）'),
      label: S('新版本名称'),
      maxEntries: N('最多保留几段经历，默认 6'),
      bulletsPerEntry: N('每段最多几条要点，默认 4'),
      dryRun: B('只出方案不建版本，默认 false'),
      reason: S('这次调整的原因（写进谱系备注）'),
    },
    required: ['jobId'],
    handler: (args) => {
      const job = repos.jobs.getJob(String(args.jobId))
      if (!job) throw new Error('目标岗位不存在')
      const experiences = repos.profile.listExperiences()
      if (!experiences.length) {
        return {
          ok: false,
          error: '素材库为空，无法微调',
          next: '先用面板「上传简历」导入并沉淀素材，或 career_experience_add 逐条补充。',
        }
      }
      const plan = planTailor({
        experiences,
        job,
        maxEntries: Number(args.maxEntries ?? 6),
        bulletsPerEntry: Number(args.bulletsPerEntry ?? 4),
      })
      const profile = repos.profile.get()
      // 章节顺序随岗位性质走：产品/市场岗把实操经历放前面，研究岗反过来。
      const sections = sectionsFromSelection(plan.selected, suggestKindOrder(job))
      const texSource = renderResumeTex({ profile, sections })
      const rawText = renderResumeText({ profile, sections })

      if (args.dryRun === true) {
        return { ok: true, dryRun: true, plan, sections, texSource, bulletCount: rawText.split('\n').filter((l) => l.startsWith('- ')).length }
      }

      const label = str(args.label, 200) ?? `${job.company_name}·${job.title} 定制版`
      const version = repos.profile.createVersionFromSections({
        label,
        sections,
        profile,
        rawText,
        texSource,
        parentVersionId: args.baseVersionId ?? repos.profile.activeResume()?.id ?? null,
        targetJobId: job.id,
        sourceType: 'tailored',
        targetRole: job.title,
        setActive: false,
      })
      panel.publish({ kind: 'resume', resumeId: version.id })
      return {
        ok: true,
        versionId: version.id,
        label,
        targetJob: { id: job.id, company: job.company_name, title: job.title },
        usedExperiences: plan.selected.length,
        omittedExperiences: plan.omitted.map((o) => ({ id: o.experienceId, org: o.organization, role: o.role, reason: o.reason })),
        gaps: plan.gaps,
        rationale: plan.rationale,
        warnings: plan.warnings,
        texSource,
        next: '版本已生成（未自动设为当前版本）。去面板「简历工作室」看 LaTeX 与 PDF，改完再 career_resume_compile。',
      }
    },
  }))

  add(makeTool({
    name: 'career_resume_tex',
    description: '读取或保存某一版简历的 LaTeX 源码；给 versionId 且不传 tex 时返回源码，传 tex 时保存。也可以在没有任何 LaTeX 时用 fromVersion 从纯文本版本重新生成骨架。',
    params: {
      versionId: S('简历版本 id'),
      tex: S('要保存的 LaTeX 源码（不传则读取）'),
      regenerate: B('设为 true 时用该版本的解析结果重新生成 LaTeX 骨架'),
      title: S('文档标题（重新生成时用）'),
    },
    required: ['versionId'],
    handler: (args) => {
      const id = String(args.versionId)
      const resume = repos.profile.getResume(id)
      if (!resume) throw new Error('简历版本不存在')
      let tex = args.tex !== undefined ? String(args.tex) : null
      if (!tex && args.regenerate === true) {
        const sections = resume.parsed?.sections ?? []
        tex = renderResumeTex({
          profile: repos.profile.get(),
          sections,
          title: args.title ?? resume.label,
        })
        repos.profile.setResumeTex(id, tex)
      }
      if (tex !== null) {
        repos.profile.setResumeTex(id, tex)
        panel.publish({ kind: 'resume', resumeId: id })
        return { ok: true, versionId: id, saved: true, chars: tex.length, tex }
      }
      const current = repos.profile.getResumeTex(id)
      const engines = detectEngines()
      return {
        ok: true,
        versionId: id,
        tex: current,
        empty: !current,
        engines: engines.map((e) => e.engine),
        hint: current ? '可调用 career_resume_compile 编译成 PDF。' : '这一版还没有 LaTeX 源码，用 regenerate=true 生成骨架，或在面板里直接写。',
      }
    },
  }))

  add(makeTool({
    name: 'career_resume_compile',
    description: '把某一版简历的 LaTeX 编译成 PDF（本机 xelatex/lualatex/pdflatex，带 -no-shell-escape 与超时保护），返回 PDF 路径与编译日志。相同源码会复用缓存。',
    params: { versionId: S('简历版本 id'), tex: S('可选：临时用这段 LaTeX 编译而不保存') },
    required: ['versionId'],
    async handler(args) {
      const id = String(args.versionId)
      const tex = args.tex !== undefined ? String(args.tex) : repos.profile.getResumeTex(id)
      if (!tex) throw new Error('这一版还没有 LaTeX 源码；先 career_resume_tex regenerate=true')
      const engines = detectEngines()
      const result = await compileTex(tex, { dataDir: config.dataDir, timeoutMs: 60_000, preferEngine: engines[0]?.engine })
      return {
        ok: result.ok,
        versionId: id,
        engine: result.engine,
        cached: result.cached === true,
        ms: result.ms,
        pdfPath: result.pdfPath ?? null,
        error: result.error ?? null,
        logTail: result.ok ? null : result.log,
        availableEngines: engines.map((e) => e.engine),
      }
    },
  }))

  // ── 多源简历合并 → 干净素材库 ──────────────────────────────────────────────
  const scanResumeFiles = (dir, cap = 40) => {
    const out = []
    const walk = (current, depth) => {
      if (out.length >= cap || depth > 3) return
      let entries = []
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= cap) break
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (/^(node_modules|\.git|System Volume Information|\$RECYCLE\.BIN)$/i.test(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        if (!/\.(pdf|docx|md|txt|json)$/i.test(entry.name)) continue
        if (/^~\$/.test(entry.name)) continue
        out.push(full)
      }
    }
    walk(dir, 0)
    return out
  }

  add(makeTool({
    name: 'career_resume_ingest',
    description: '一次性导入一堆简历：给目录（递归扫描 pdf/docx/md/txt）、给多个文件路径、或直接给多段文本。逐个提取原文并按内容去重，全部作为「源材料」存起来（不覆盖画像）。这是「我有一堆乱七八糟的简历」的入口。之后用 career_vault_plan_merge 去重合并成干净素材库。',
    params: {
      dir: S('目录绝对路径，递归找简历类文件（最多 40 个）'),
      paths: SA('一个或多个文件绝对路径'),
      texts: { type: 'array', items: { type: 'object' }, description: '直接给文本：[{label, text}]' },
      seedVault: B('是否顺手把解析出的经历写入素材库（默认 false，建议合并时统一处理）'),
      maxFiles: N('上限，默认 40'),
    },
    async handler(args) {
      const cap = Math.min(Number(args.maxFiles ?? 40), 80)
      const files = []
      for (const item of arr(args.paths)) files.push(String(item))
      if (args.dir) files.push(...scanResumeFiles(String(args.dir), cap))
      const sources = Array.isArray(args.texts) ? args.texts : []
      if (!files.length && !sources.length) throw new Error('需要 dir / paths / texts 之一')

      const existing = new Set(repos.profile.rawSources({ maxChars: 400000 }).map((s) => normKey(s.text ?? '').slice(0, 4000)))
      const ingested = []
      const failed = []
      const duplicates = []

      const before = repos.profile.listResumes().length
      for (const filePath of files.slice(0, cap)) {
        try {
          const extracted = await extractResumeText(filePath, { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
          if (!extracted.ok) {
            failed.push({ path: filePath, error: extracted.error })
            continue
          }
          const fingerprint = normKey(extracted.text ?? '').slice(0, 4000)
          if (existing.has(fingerprint)) {
            duplicates.push({ path: filePath, reason: '与已导入的某份内容相同' })
            continue
          }
          existing.add(fingerprint)
          const proposal = parseResume(extracted.text, { fileName: path.basename(filePath) })
          const resume = repos.profile.addResume({
            label: path.basename(filePath),
            fileName: path.basename(filePath),
            filePath,
            mime: extracted.format ?? 'file',
            rawText: extracted.text,
            parsed: proposal,
            parseStatus: 'needs_review',
            parseNotes: [...(extracted.notes ?? []), ...proposal.notes].join('；') || null,
            sourceType: 'upload',
            setActive: false,
          })
          if (args.seedVault === true) repos.profile.importExperiencesFromResume(proposal, resume.id)
          ingested.push({
            resumeId: resume.id,
            fileName: path.basename(filePath),
            format: extracted.format,
            engine: extracted.engine ?? null,
            chars: (extracted.text ?? '').length,
            parseConfidence: proposal.confidence,
          })
        } catch (err) {
          failed.push({ path: filePath, error: String(err?.message ?? err) })
        }
      }

      for (const [index, item] of sources.entries()) {
        const text = String(item?.text ?? '').trim()
        if (!text) {
          failed.push({ source: item?.label ?? `text#${index}`, error: '空文本' })
          continue
        }
        const fingerprint = normKey(text).slice(0, 4000)
        if (existing.has(fingerprint)) {
          duplicates.push({ source: item?.label ?? `text#${index}`, reason: '内容重复' })
          continue
        }
        existing.add(fingerprint)
        const proposal = parseResume(text, { fileName: item?.label ?? null })
        const resume = repos.profile.addResume({
          label: item?.label ?? `粘贴材料 #${index + 1}`,
          rawText: text,
          parsed: proposal,
          parseStatus: 'needs_review',
          parseNotes: proposal.notes.join('；') || null,
          sourceType: 'paste',
          setActive: false,
        })
        if (args.seedVault === true) repos.profile.importExperiencesFromResume(proposal, resume.id)
        ingested.push({ resumeId: resume.id, fileName: item?.label ?? `text#${index + 1}`, format: 'text', chars: text.length, parseConfidence: proposal.confidence })
      }

      panel.publish({ kind: 'resume', resumeId: null })
      return {
        ok: true,
        ingested,
        duplicates,
        failed,
        totals: { files: files.length, texts: sources.length, ingested: ingested.length, duplicate: duplicates.length, failed: failed.length, versionsBefore: before },
        next: '下一步：career_vault_snapshot 读取所有原文与现有素材 → 自己归并成结构化经历 → career_vault_plan_merge 校验去重/冲突 → career_vault_apply 落库。原始文件都保留，合并可回溯。',
        caveat: '解析器只做初判，学术型/排版怪异的 CV 容易被读错，所以这里只存原文，结构化靠合并环节人工把关。',
      }
    },
  }))

  add(makeTool({
    name: 'career_vault_snapshot',
    description: '读取「合并工作台」全量现场：所有源材料原文（可截断）、现有素材库条目、以及库健康检查（疑似重复/空要点/未确认）。合并前先调它。',
    params: {
      maxCharsPerSource: N('每份源材料最多返回多少字符，默认 6000'),
      onlyKind: S('只看某类素材'),
    },
    handler: (args) => {
      const sources = repos.profile.rawSources({ maxChars: Math.min(Number(args.maxCharsPerSource ?? 6000), 30000) })
      const experiences = repos.profile.listExperiences({ kind: args.onlyKind })
      return {
        ok: true,
        sources,
        experiences,
        audit: auditVault(experiences),
        counts: { sources: sources.length, experiences: experiences.length },
        howTo: '把 sources 的原文与 experiences 对照，输出「新增/更新/冲突」三组；用 career_vault_plan_merge 让系统做确定性去重，再 career_vault_apply 落库。',
      }
    },
  }))

  add(makeTool({
    name: 'career_vault_plan_merge',
    description: '合并计划（确定性、不写库）：把你从一堆简历里整理出的候选经历和现有素材库比对，输出 新增/更新（含新增要点）/批内重复/字段冲突。只合并不编造，冲突项要人来定。',
    params: {
      incoming: { type: 'array', items: { type: 'object' }, description: '候选经历数组，字段同 career_experience_add' },
      allowLoose: B('允许按「同一机构」近似合并（默认 false，更保守）'),
    },
    required: ['incoming'],
    handler: (args) => {
      const incoming = (Array.isArray(args.incoming) ? args.incoming : []).map((item, index) => ({
        ...item,
        __sourceLabel: item?.sourceLabel ?? item?.from ?? `candidate#${index + 1}`,
        __sourceId: item?.sourceId ?? null,
      }))
      const plan = planMerge({
        existing: repos.profile.listExperiences(),
        incoming,
        allowLoose: args.allowLoose === true,
      })
      return { ok: true, ...plan, next: '确认后用 career_vault_apply 落库（可先 dryRun=true 预演）。' }
    },
  }))

  add(makeTool({
    name: 'career_vault_apply',
    description: '把合并计划落库（批量、事务、可先 dryRun 预演）。creates/updates/deletes 三组；不会改动原始简历版本，素材库可再合并。',
    params: {
      creates: { type: 'array', items: { type: 'object' }, description: '新增条（或直接传 plan.creates）' },
      updates: { type: 'array', items: { type: 'object' }, description: '[{id, patch}] 或直接传 plan.updates' },
      deletes: SA('要删除的素材 id'),
      dryRun: B('只预演不写库，默认 false'),
    },
    handler: (args) => {
      const creates = (Array.isArray(args.creates) ? args.creates : []).map((c) => (c?.incoming ? c : { incoming: c }))
      const updates = (Array.isArray(args.updates) ? args.updates : []).map((u) => ({ id: u?.id, patch: u?.patch ?? {} }))
      const result = repos.profile.applyVaultOps({ creates, updates, deletes: arr(args.deletes) }, { dryRun: args.dryRun === true })
      if (args.dryRun !== true) panel.publish({ kind: 'resume', resumeId: null })
      return { ok: true, ...result, next: '落库后跑 career_vault_snapshot 复核，或直接 career_resume_build 出稿。' }
    },
  }))

  add(makeTool({
    name: 'career_resume_build',
    description: '针对某个岗位从素材库出「最合适的一版简历」：按岗位关键词挑选/排序/精简，支持强制包含与排除某几段经历，生成 LaTeX + 纯文本并可存为版本。只挑选和排序，不编造内容。',
    params: {
      jobId: S('目标岗位 id（必填）'),
      includeIds: SA('必须包含的素材 id'),
      excludeIds: SA('必须排除的素材 id'),
      maxEntries: N('最多保留几段经历，默认 6'),
      bulletsPerEntry: N('每段最多几条要点，默认 4'),
      includeDocs: B('是否把个人资料库里的证书/成绩按岗位相关性加进「证书与语言」，默认 true'),
      docIds: SA('指定必须展示的资料 id'),
      docMax: N('最多带几条资料，默认 6'),
      label: S('新版本名称'),
      baseVersionId: S('基于哪一版（谱系用）'),
      save: B('是否存成简历版本，默认 true'),
    },
    required: ['jobId'],
    handler: (args) => {
      const job = repos.jobs.getJob(String(args.jobId))
      if (!job) throw new Error('目标岗位不存在')
      const experiences = repos.profile.listExperiences()
      if (!experiences.length) {
        return { ok: false, error: '素材库为空', next: '先用 career_resume_ingest 批量导入，再合并成素材库。' }
      }
      const plan = planTailor({
        experiences,
        job,
        maxEntries: Number(args.maxEntries ?? 6),
        bulletsPerEntry: Number(args.bulletsPerEntry ?? 4),
        includeIds: arr(args.includeIds),
        excludeIds: arr(args.excludeIds),
      })
      const profile = repos.profile.get()
      const sections = sectionsFromSelection(plan.selected, suggestKindOrder(job))

      // 证书与语言：按岗位相关性从个人资料库里挑，挑不出来就不加这一节。
      let docPlan = null
      if (args.includeDocs !== false) {
        const documents = repos.profile.listDocuments({})
        const forced = arr(args.docIds)
        const picked = forced.length
          ? documents.filter((doc) => forced.includes(doc.id))
          : planDocumentSelection({ documents, job, max: Number(args.docMax ?? 6) }).selected
            .map((row) => documents.find((doc) => doc.id === row.id))
            .filter(Boolean)
        const groups = renderDocumentLines(picked)
        if (groups.length) {
          sections.push({
            kind: 'certificate',
            label: '证书与语言',
            items: groups.map((group) => ({ org: null, role: null, period: null, location: null, bullets: group.lines })),
          })
          docPlan = { used: picked.length, groups: groups.map((group) => ({ label: group.label, lines: group.lines })) }
        }
      }

      const texSource = renderResumeTex({ profile, sections })
      const rawText = renderResumeText({ profile, sections })
      let versionId = null
      if (args.save !== false) {
        const label = str(args.label, 200) ?? `${job.company_name}·${job.title} 匹配版`
        const version = repos.profile.createVersionFromSections({
          label, sections, profile, rawText, texSource,
          parentVersionId: args.baseVersionId ?? null,
          targetJobId: job.id,
          sourceType: 'tailored',
          targetRole: job.title,
          setActive: false,
        })
        versionId = version.id
        panel.publish({ kind: 'resume', resumeId: versionId })
      }
      return {
        ok: true,
        versionId,
        targetJob: { id: job.id, company: job.company_name, title: job.title },
        selected: plan.selected.map((s) => ({ id: s.experienceId, org: s.organization, role: s.role, bullets: s.bullets.length })),
        omitted: plan.omitted.map((o) => ({ id: o.experienceId, org: o.organization, reason: o.reason })),
        gaps: plan.gaps,
        rationale: plan.rationale,
        warnings: plan.warnings,
        documents: docPlan,
        texSource,
        preview: rawText,
        next: versionId ? '版本已生成。career_resume_compile 出 PDF，或到面板「简历工作室」改 LaTeX。' : '已出方案但未存版本。',
      }
    },
  }))

  // ── 个人资料库（学历/成绩/证书/专利）──────────────────────────────────────
  const docsDir = path.join(config.dataDir, 'documents')
  const saveDocFile = (fileName, base64) => {
    fs.mkdirSync(docsDir, { recursive: true })
    const safe = String(fileName ?? 'doc').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'doc'
    const target = path.join(docsDir, `${Date.now()}-${safe}`)
    fs.writeFileSync(target, Buffer.from(String(base64 ?? ''), 'base64'))
    return target
  }

  add(makeTool({
    name: 'career_doc_ingest',
    description: '把学历证明、成绩单、四六级/托福成绩、专利证书、获奖证明等一并存入「个人资料库」。可给目录/多个路径/面板上传的 base64。系统按文件名与正文自动判断类别并抽取分数（托福/雅思/四六级/GPA），**保存前一律标为未确认**，等你核对。',
    params: {
      dir: S('目录绝对路径，递归找 pdf/docx/图片/md/txt（最多 40 个）'),
      paths: SA('一个或多个文件绝对路径'),
      fileName: S('面板上传时的原始文件名'), dataBase64: S('面板上传时的 base64'),
      category: S('手动指定类别：degree|transcript|certificate|language|award|patent|publication|portfolio|identity|other'),
      save: B('是否直接入库（默认 false，先返回候选让你确认）'),
      verified: B('是否直接标为已确认，默认 false'),
    },
    async handler(args) {
      const files = []
      for (const item of arr(args.paths)) files.push(String(item))
      if (args.dir) files.push(...scanResumeFiles(String(args.dir), 40))
      if (args.dataBase64) files.push(saveDocFile(args.fileName, args.dataBase64))
      if (!files.length) throw new Error('需要 dir / paths / dataBase64 之一')

      const results = []
      for (const filePath of files.slice(0, 40)) {
        const fileName = path.basename(filePath)
        const ext = path.extname(filePath).toLowerCase()
        if (/\.(png|jpe?g|webp)$/i.test(ext)) {
          // 图片型证明（扫描件）：不做 OCR，只登记并提示补信息
          const proposal = proposeDocument({ fileName, text: '', filePath, mime: ext.slice(1) })
          const saved = args.save === true
            ? repos.profile.addDocument({ ...proposal, filePath, fileName, mime: ext.slice(1), verified: args.verified === true, notes: '扫描件/图片：未做 OCR，字段需手工补' })
            : null
          results.push({ fileName, kind: 'image', proposal, savedId: saved?.id ?? null, note: '图片未做 OCR' })
          continue
        }
        const extracted = await extractResumeText(filePath, { pythonPath: config.pythonPath, timeoutMs: config.httpTimeoutMs })
        if (!extracted.ok) {
          results.push({ fileName, error: extracted.error })
          continue
        }
        const proposal = proposeDocument({ fileName, text: extracted.text, filePath, mime: extracted.format })
        if (args.category) proposal.category = String(args.category)
        let saved = null
        if (args.save === true) {
          saved = repos.profile.addDocument({
            ...proposal, rawText: extracted.text, filePath, fileName,
            mime: extracted.format, verified: args.verified === true,
          })
        }
        results.push({ fileName, chars: (extracted.text ?? '').length, proposal, savedId: saved?.id ?? null })
      }
      if (args.save === true) panel.publish({ kind: 'resume', resumeId: null })
      return {
        ok: true,
        save: args.save === true,
        results,
        note: '类别与分数是自动判断的，可能不准；保存后请用 career_doc_update 核对标题/颁发机构/时间/证书编号，并把 verified 置 true。',
        totals: { files: files.length, saved: results.filter((r) => r.savedId).length },
      }
    },
  }))

  add(makeTool({
    name: 'career_doc_list',
    description: '列出个人资料库（学历/成绩/语言/专利/获奖…），可按类别与关键词过滤，附库统计。',
    params: {
      category: SA('类别过滤'),
      query: S('关键词（标题/机构/分数/编号/正文）'),
      verified: B('只看已确认 / 只看未确认'),
    },
    handler: (args) => ({
      ok: true,
      ...repos.profile.documentStats(),
      categories: DOC_LABEL,
      documents: repos.profile.listDocuments({ category: args.category, query: args.query, verified: args.verified }),
    }),
  }))

  add(makeTool({
    name: 'career_doc_update',
    description: '修改一条个人资料（标题/机构/取得时间/证书编号/分数/类别/标签/备注），或标记已确认、或删除。',
    params: {
      id: S('资料 id'), delete: B('设为 true 表示删除'),
      category: S('类别'), title: S('标题'), issuer: S('颁发机构'),
      issuedAt: S('取得时间 YYYY-MM'), expiresAt: S('有效期'),
      credentialId: S('证书编号/专利号'), score: S('分数原文'), scoreValue: N('分数数值'), scoreUnit: S('分/级/GPA'),
      tags: SA('标签'), verified: B('是否已确认属实'), notes: S('备注'),
    },
    required: ['id'],
    handler: (args) => {
      if (args.delete === true) return { ok: true, deleted: repos.profile.deleteDocument(String(args.id)) }
      return { ok: true, document: repos.profile.updateDocument(String(args.id), args) }
    },
  }))

  add(makeTool({
    name: 'career_doc_for_job',
    description: '按某个岗位从个人资料库里「按需提取」该展示的资质：给每条资料算相关性并说明理由，输出可直接放进简历的「证书与语言」行。不做真伪判断。',
    params: {
      jobId: S('目标岗位 id'),
      categories: SA('只在某些类别里挑'),
      max: N('最多几条，默认 8'),
      jd: S('也可以直接给 JD 文本（没有岗位 id 时）'),
    },
    handler: (args) => {
      let job = null
      if (args.jobId) {
        job = repos.jobs.getJob(String(args.jobId))
        if (!job) throw new Error('目标岗位不存在')
      } else if (args.jd) {
        job = { title: '', description: String(args.jd), requirements: '', skills: [] }
      } else {
        throw new Error('需要 jobId 或 jd')
      }
      const documents = repos.profile.listDocuments({})
      const plan = planDocumentSelection({ documents, job, max: Number(args.max ?? 8), categories: arr(args.categories) })
      return {
        ok: true,
        job: args.jobId ? { id: job.id, title: job.title, company: job.company_name } : null,
        ...plan,
        groups: renderDocumentLines(documents.filter((d) => plan.selected.some((s) => s.id === d.id))),
        next: '把 groups 的 lines 放进简历「证书与语言」小节；用 career_resume_build 的 includeDocs 会自动带上。',
      }
    },
  }))

  // ── company / industry / research ──────────────────────────────────────────
  add(makeTool({
    name: 'career_company_upsert',
    description: '建立/更新公司档案（官网、招聘入口、城市、标签、业务数据）。招聘入口填了才能做官方页监控。',
    params: {
      name: S('公司名（必填）'), id: S('已有公司 id（可选）'),
      aliases: SA('别名，如「字节」「ByteDance」'),
      website: S('官网'), careersUrl: S('官方招聘/校招页面 URL'), internUrl: S('实习招聘页 URL'),
      cities: SA('办公城市'), size: S('规模'), tags: SA('标签'),
      notes: S('备注'), data: { type: 'object', description: '结构化研究数据（业务线、商业模式、近期动态等）' },
      interest: S('watch|target|exclude'),
    },
    required: ['name'],
    handler: (args) => {
      const company = repos.jobs.upsertCompany(args)
      if (args.interest) repos.jobs.setWatch(company.id, args.interest, args.notes)
      return { ok: true, company }
    },
  }))

  add(makeTool({
    name: 'career_company_get',
    description: '公司档案 + 在库岗位 + 关注状态 + 研究简报列表 + 论坛观点统计。研究一家公司值不值得去时先读它。',
    params: { id: S('公司 id'), name: S('或公司名') },
    handler: (args) => {
      const company = args.id ? repos.jobs.getCompany(String(args.id)) : repos.jobs.getCompany(repos.jobs.resolveCompany(String(args.name ?? ''), false)?.id)
      if (!company) return { ok: false, error: '公司档案不存在，可先用 career_company_upsert 建立' }
      return { ok: true, company }
    },
  }))

  add(makeTool({
    name: 'career_industry_upsert',
    description: '建立/更新行业档案（定义、产业链、格局、驱动因素、风险、情景展望等，放在 data 对象里）。',
    params: { name: S('行业名（必填）'), summary: S('行业摘要 Markdown'), data: { type: 'object', description: '结构化字段' }, parentId: S('父级行业 id') },
    required: ['name'],
    handler: (args) => ({ ok: true, industry: repos.intel.upsertIndustry(args) }),
  }))

  add(makeTool({
    name: 'career_industry_list',
    description: '列出行业档案（含公司数量）。',
    params: {},
    handler: () => ({ ok: true, industries: repos.intel.listIndustries() }),
  }))

  add(makeTool({
    name: 'career_research_save',
    description: '保存行业/公司研究简报（Markdown 正文 + 来源列表 + 数据时点）。再次保存同一 id 会 version+1，形成更新历史。',
    params: {
      id: S('已有报告 id（更新时传）'), kind: S('industry|company|bar|interview|summary'),
      title: S('标题（必填）'), body: S('Markdown 正文（必填）'),
      industryId: S('关联行业 id'), companyId: S('关联公司 id'),
      sources: SA('来源链接/名称列表'), dataAsOf: S('数据时点 YYYY-MM-DD'),
    },
    required: ['title', 'body'],
    handler: (args) => ({ ok: true, report: repos.intel.saveReport({ ...args, dataAsOf: args.dataAsOf ?? nowIso().slice(0, 10) }) }),
  }))

  add(makeTool({
    name: 'career_evidence_add',
    description: '登记一条证据（来源类型/链接/时间/核验状态/摘录/可信度 A-E）。用于给重要结论留溯源。',
    params: {
      subjectType: S('company|job|industry|claim'), subjectId: S('对应实体 id'),
      sourceType: S('official_careers|filing|news|forum|search|manual'),
      sourceUrl: S('链接'), publishedAt: S('发布时间'), claimType: S('宣称类型，如 job_opening'),
      excerpt: S('简短摘录（不要存整页）'), confidenceLevel: S('A|B|C|D|U'), verificationStatus: S('verified|unverified|stale|conflicting'),
    },
    required: ['subjectType'],
    handler: (args) => ({ ok: true, evidence: repos.intel.addEvidence(args) }),
  }))

  // ── social / bar / interview ───────────────────────────────────────────────
  add(makeTool({
    name: 'career_forum_import',
    description: '导入一条论坛/面经内容（用户粘贴或合法导出）。自动去重，并抽取 claims（招聘 bar/面试/体验）与面试经历。accessMode 记录获取方式，禁止伪造正文。',
    params: {
      platform: S('xiaohongshu|nowcoder|zhihu|maimai|v2ex|1point3acres|github|other（必填）'),
      content: S('正文或核心摘录（必填）'),
      url: S('原链接'), title: S('标题'), author: S('公开昵称（不要收集个人信息）'),
      publishedAt: S('发布时间 YYYY-MM-DD'),
      company: S('关联公司名'), jobTitle: S('关联岗位名'),
      accessMode: S('manual_import|user_export|public_page|search_snippet'),
      claims: {
        type: 'array', items: { type: 'object' },
        description: '结构化观点 [{category:bar|interview|experience|salary|process, claim, stance, evidenceLevel, observedYear, department, sampleSize}]',
      },
      interview: {
        type: 'object',
        description: '面试经历 {stage, year, roleTitle, topics:[], questions:[], outcome, timeline}',
      },
    },
    required: ['platform', 'content'],
    handler: (args) => {
      const post = repos.intel.addForumPost(args)
      repos.knowledge.upsert({kind:'interview',title:args.title??'手动导入面经',company:args.company,role:args.jobTitle,platform:args.platform,url:args.url,body:args.content,completeness:'full',evidenceLevel:'C',sourceEntityType:'forum_post',sourceEntityId:post.id})
      if (post.duplicate) return { ok: true, duplicate: true, postId: post.id, note: '这条内容已入库（按内容哈希去重），不重复计入证据。' }
      const claims = Array.isArray(args.claims) ? args.claims : []
      const created = claims.map((c) => repos.intel.addClaim({
        postId: post.id, category: c.category, claim: c.claim, stance: c.stance,
        evidenceLevel: c.evidenceLevel ?? 'C', observedYear: c.observedYear, department: c.department,
        sampleSize: c.sampleSize, firstHand: args.accessMode === 'manual_import' || args.accessMode === undefined,
        companyId: post.company_id, jobId: post.job_id,
      }))
      let interview = null
      if (args.interview) {
        interview = repos.intel.addInterview({
          ...args.interview, postId: post.id, url: args.url,
          companyId: post.company_id, jobId: post.job_id, evidenceLevel: 'C',
        })
      }
      return {
        ok: true, postId: post.id, claims: created.length, interview,
        evidenceRule: '单条自述 = C 级；只有独立来源相互印证才能升到 B；不能当企业整体事实，也不能外推为录用概率。',
      }
    },
  }))

  add(makeTool({
    name: 'career_bar_analyze',
    description: '招聘 Bar 分析：严格分层输出 hard（官方硬性）/preferred（官方加分）/observed（公开经验规律）/unverified（传闻），并附论坛信号与免责声明。',
    params: { companyId: S('公司 id'), company: S('公司名'), jobId: S('岗位 id（可选）') },
    handler: (args) => {
      const bar = repos.intel.barFor(args)
      return {
        ok: true,
        ...bar,
        interviewExperiences: repos.intel.listInterviews({ companyId: bar.companyId, limit: 20 }),
      }
    },
  }))

  add(makeTool({
    name: 'career_social_queries',
    description: '为无法自动抓取的平台（小红书/牛客/知乎/脉脉等）生成搜索关键词与公开搜索链接，供用户自己浏览后粘贴回来。',
    params: { company: S('公司名'), role: S('岗位'), year: N('年份') },
    handler: (args) => ({ ok: true, ...suggestSocialQueries(args) }),
  }))

  add(makeTool({
    name: 'career_jd_interview',
    description: '给一段 JD，分析可能的面试问题与知识点。知识点只从 JD 实际出现的词推导；生成的问题明确标为 AI 练习方向（不是真实面试题）；若给了 jobId，会额外带出已导入的真实面经（证据 C，样本有限）。',
    params: {
      jd: S('JD 原文（直接粘贴；与 jobId 二选一）'),
      jobId: S('岗位 id（可选，会自动取库里已存的 JD 正文）'),
      title: S('岗位名（可选）'),
      company: S('公司名（可选）'),
      research: { type: 'array', items: { type: 'object' }, description: '外部调研材料：[{source,url,publishedAt,evidenceLevel,questions:[]}]，把你在牛客/知乎等合法看到的面经问题传入，本工具会跨来源去重聚合' },
    },
    handler: (args) => {
      let jdText = str(args.jd, 20000)
      let job = null
      let companyName = str(args.company, 200) ?? null
      if (!jdText && args.jobId) {
        job = repos.jobs.getJob(String(args.jobId))
        if (job) {
          jdText = [job.description, job.requirements].filter(Boolean).join('\n')
          companyName = companyName ?? job.company_name
        }
      }
      const real = args.jobId
        ? repos.intel.listInterviews({ jobId: job?.id, companyId: job?.company_id, limit: 50 })
        : []
      return buildInterviewPlan({
        jdText,
        title: str(args.title, 200) ?? job?.title ?? null,
        company: companyName,
        realExperiences: real,
        research: Array.isArray(args.research) ? args.research : [],
      })
    },
  }))

  add(makeTool({
    name: 'career_interview_prep',
    description: '生成面试准备包：公司/岗位背景、核心能力、公开流程、面经主题汇总、高频题、简历追问、业务思考题、必须区分的「真实面经 vs AI 生成练习」。',
    params: { jobId: S('岗位 id（可选）'), companyId: S('公司 id（可选）'), company: S('公司名'), role: S('岗位名') },
    handler: (args) => {
      const job = args.jobId ? repos.jobs.getJob(String(args.jobId)) : null
      const companyId = args.companyId ?? job?.company_id ?? (args.company ? repos.jobs.resolveCompany(String(args.company), false)?.id : null)
      const interviews = repos.intel.listInterviews({ companyId, jobId: job?.id, limit: 50 })
      const bar = repos.intel.barFor({ companyId, jobId: job?.id })
      const profile = repos.profile.get()
      const realTopics = [...new Set(interviews.flatMap((i) => i.topics))]
      const realQuestions = [...new Set(interviews.flatMap((i) => i.questions))]
      return {
        ok: true,
        target: {
          job: job ? { id: job.id, title: job.title, company: job.company_name, department: job.department } : null,
          companyId,
          role: job?.title ?? args.role ?? null,
        },
        companyContext: '用 career_company_get / career_research_save 填充业务与部门背景，不要凭空写。',
        coreCompetencies: job?.skills ?? [],
        realInterviewProcess: interviews.map((i) => ({ year: i.year, stage: i.stage, outcome: i.outcome, source: i.source_url })),
        realTopics,
        realQuestions,
        hardRequirements: bar.hard,
        observedPatterns: bar.observed,
        resumeFollowUps: profile.skills.slice(0, 8).map((s) => `就「${s.name}」准备一个 STAR：背景→你的动作→量化结果（只用真实数据）`),
        behaviorQuestions: ['为什么选这个岗位/这个部门', '讲一次你从 0 推动一件事的经历', '讲一次你和人意见冲突怎么解决'],
        practicePlan: '用真实经历准备 STAR 草稿；不会的问题明确说不会并给出学习路径。',
        provenance: {
          real: 'realTopics/realQuestions 来自已导入的面经原文（C 级证据，样本有限）',
          generated: 'behaviorQuestions / practicePlan 是 AI 生成的练习建议，不是真实面经',
        },
      }
    },
  }))

  // ── matching ───────────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_match_rank',
    description: '按当前画像给全部在库岗位重算匹配分并分组（高优先级/值得尝试/需要补强/硬条件不符/信息不足）。分数表示与你的偏好匹配度，不是录用概率。',
    params: { limit: N('每组返回条数，默认 10') },
    handler: (args) => {
      const profile = repos.profile.getWithResume()
      profile.__hash = repos.profile.hash()
      const ranked = repos.jobs.rankAll(profile)
      const limit = Math.min(Number(args.limit ?? 10), 30)
      const groups = {}
      for (const band of Object.keys(MATCH_BANDS)) groups[band] = []
      for (const { job, analysis } of ranked) {
        if (groups[analysis.band].length >= limit) continue
        groups[analysis.band].push({
          id: job.id, company: job.company_name, title: job.title, location: job.location,
          status: job.status, deadline: job.deadline, score: analysis.score,
          topReasons: analysis.reasons.matched.slice(0, 3),
          blockers: analysis.hardBlocks,
          missing: analysis.reasons.missing.slice(0, 3),
        })
      }
      return {
        ok: true,
        weights: ranked[0]?.analysis?.weights ?? null,
        bands: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { label: MATCH_BANDS[k], items: v }])),
        rankedTotal: ranked.length,
        disclaimer: '分数 = 与个人偏好的匹配度（硬条件过滤 + 维度加权），不代表录用概率，也不预测竞争者数量。',
      }
    },
  }))

  add(makeTool({
    name: 'career_match_job',
    description: '解释单个岗位的匹配结果：各维度得分、已满足/未满足/需核实项、建议突出的经历，并说明是否值得优先申请。',
    params: { id: S('岗位 id'), weights: { type: 'object', description: '临时覆盖权重（可选）' } },
    required: ['id'],
    handler: (args) => {
      const job = repos.jobs.getJob(String(args.id))
      if (!job) throw new Error('岗位不存在')
      const profile = repos.profile.getWithResume()
      const analysis = analyzeMatch(profile, job, args.weights)
      return {
        ok: true,
        job: { id: job.id, company: job.company_name, title: job.title, status: job.status },
        ...analysis,
        verdict: analysis.band === 'hard_mismatch'
          ? '先解决硬条件不符（见 hardBlocks），否则不建议投'
          : analysis.band === 'insufficient_info'
            ? 'JD 信息不足，先补齐岗位描述再评估'
            : '可以投，按 reasons.highlight 调整简历重点',
      }
    },
  }))

  // ── applications ───────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_application_create',
    description: '创建投递记录（状态默认 saved）。收藏时保留草稿，首次正式投递时冻结最终 JD、简历及资料内容，之后原材料变化不影响复盘。若同公司近期投过会给出冷冻期提醒。不会替你投递，只记录。',
    params: {
      jobId: S('岗位 id（推荐，会自动带公司/岗位名）'), companyName: S('公司名'), jobTitle: S('岗位名'),
      status: S(APPLICATION_STATUSES.join('|')), channel: S('投递渠道'), url: S('岗位链接'),
      resumeVersionId: S('使用的简历版本'), nextAction: S('下一步动作'), nextActionAt: S('下一步日期 YYYY-MM-DD'), notes: S('备注'),
      jd: S('JD 原文（岗位库里没有时直接粘进来，会被冻结保存）'),
      jdUrl: S('JD 原文链接'),
      docIds: SA('这次一起提交的资料 id（来自个人资料库）'),
      snapshotNote: S('材料快照备注'),
      skipCooldownCheck: B('跳过同公司冷冻期检查'),
    },
    handler: (args) => {
      let cooldown = null
      if (args.skipCooldownCheck !== true) {
        const company = str(args.companyName, 200)
          ?? (args.jobId ? repos.jobs.getJob(String(args.jobId))?.company_name : null)
        if (company) cooldown = repos.applications.cooldownCheck({ companyName: company })
      }
      const application = repos.applications.create(args)
      return {
        ok: true,
        application,
        hasJd: Boolean(application?.submitted_jd),
        materialsSpecified: Boolean(application?.submissionSnapshot?.materialsSpecified),
        cooldown: cooldown?.blocked
          ? { warning: `近 ${cooldown.months} 个月内已投过「${cooldown.hits[0].company_name}」${cooldown.hits.length} 次，多数公司有 6 个月冷冻期，重复投递可能被直接筛掉。`, hits: cooldown.hits }
          : null,
      }
    },
  }))

  add(makeTool({
    name: 'career_funnel',
    description: '投递漏斗：按「达到过的最高阶段」统计 投递→测评/笔试→一面→二面→终面→offer 的到达人数与阶段通过率，指出卡在哪一关，并给出分渠道转化与停滞超 14 天的记录。复盘看这个，不是看投了多少家。',
    params: {},
    handler: () => {
      const funnel = repos.applications.funnel()
      return {
        ok: true,
        ...funnel,
        readHint: funnel.choke
          ? `流失最多的是「${funnel.choke.from} → ${funnel.choke.to}」：掉 ${funnel.choke.dropped} 条，通过率 ${funnel.choke.passRate ?? '—'}%。这一跳对应的能力缺口最该优先补。`
          : '还没有跨阶段的投递记录，等有面试结果再看。',
      }
    },
  }))

  add(makeTool({
    name: 'career_apply_card',
    description: '生成网申信息卡：把投递表单要填的字段（姓名/证件/学历/在读起止/排名/语言成绩/求职意向/附件）按顺序摊平，可直接复制粘贴到招聘系统，并列出本机缺哪些字段。只整理已有事实，不生成新内容。',
    params: {
      includeEmpty: B('是否也列出空字段（默认 true，方便知道去补什么）'),
      format: S('text 纯文本 / json 结构化，默认 text'),
    },
    handler: (args) => {
      const card = buildApplyCard({
        profile: repos.profile.get(),
        documents: repos.profile.listDocuments({}),
        experiences: repos.profile.listExperiences(),
        versions: repos.profile.listResumes(),
      })
      const text = renderApplyCardText(card)
      return {
        ok: true,
        ...card,
        text,
        format: args.format === 'json' ? 'json' : 'text',
        next: card.missing.length
          ? `先补这 ${card.missing.length} 项：${card.missing.slice(0, 6).map((m) => m.label).join('、')}${card.missing.length > 6 ? ' 等' : ''}（career_profile_update 或上传到资料库）`
          : '字段齐了，直接复制 text 到网申页面。',
      }
    },
  }))

  add(makeTool({
    name: 'career_application_update',
    description: '更新投递状态/下一步/备注。状态变化会写入时间线事件（不覆盖历史）。',
    params: {
      id: S('投递记录 id（必填）'), status: S(APPLICATION_STATUSES.join('|')),
      nextAction: S('下一步动作'), nextActionAt: S('下一步日期'), notes: S('备注'),
      resumeVersionId: S('草稿使用的简历版本（已投递材料不能覆盖）'),
      docIds: SA('草稿附带资料；首次正式投递时冻结，之后不能覆盖'),
      snapshotNote: S('草稿材料备注'), jd: S('草稿JD原文'), jdUrl: S('草稿JD链接'),
      result: S('结果'), retro: S('复盘'), note: S('本次变更说明'), archived: B('归档'),
    },
    required: ['id'],
    handler: (args) => ({ ok: true, application: repos.applications.update(String(args.id), args) }),
  }))

  add(makeTool({
    name: 'career_applications_list',
    description: '已投递清单：按状态/公司/招聘类型/关键词筛选，返回工作地点、投递地址、截止日期、下一步，并附逾期与长期无更新的跟进提示。',
    params: {
      status: SA('状态列表，如 ["applied","interview_1"]'),
      company: S('公司名过滤'),
      query: S('关键词（公司/岗位/备注/渠道）'),
      recruitType: SA('招聘类型过滤：autumn_campus/spring_campus/summer/daily'),
      sort: S('updated | applied | deadline'),
      limit: N('条数，默认 200'),
    },
    handler: (args) => {
      const rows = repos.applications.list({
        status: args.status,
        company: args.company,
        query: args.query,
        recruitType: args.recruitType,
        sort: args.sort,
        limit: args.limit ?? 200,
      })
      return {
        ok: true,
        count: rows.length,
        applications: rows,
        followUps: repos.applications.followUps(),
        stats: repos.applications.stats(),
        statusLabels: APPLICATION_LABEL,
        recruitLabels: RECRUIT_LABEL,
      }
    },
  }))

  add(makeTool({
    name: 'career_applications_export',
    description: '把已投递清单导出为 CSV（UTF-8 BOM，Excel 可直接打开），返回文件路径。用于备份或自己做表格跟踪。',
    params: {
      status: SA('只导出这些状态'),
      company: S('公司名过滤'),
      query: S('关键词过滤'),
    },
    handler: (args) => {
      const rows = repos.applications.list({
        status: args.status, company: args.company, query: args.query, limit: 5000, includeArchived: true,
      })
      const csv = repos.applications.toCsv(rows)
      const file = exporter.writeCsv('applications', csv)
      return { ok: true, file, rows: rows.length, bytes: csv.length }
    },
  }))

  add(makeTool({
    name: 'career_application_board',
    description: '看板视图：按投递阶段分列，可直接给面板渲染。',
    params: {},
    handler: () => ({ ok: true, ...repos.applications.board() }),
  }))

  // ── monitoring ─────────────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_monitor_create',
    description: '创建监控规则。kind=careers_page（官方招聘页变化）/job_deadline（临近截止）/keyword_search（合规搜索发现）/social_watch（论坛线索入口）。',
    params: {
      kind: S('careers_page|job_deadline|keyword_search|social_watch'),
      name: S('规则名'), spec: { type: 'object', description: 'careers_page: {url,company,autoImport}；job_deadline: {withinDays}；keyword_search: {queries,maxResults}；social_watch: {company,role}' },
      cadence: S('daily|weekly|manual'), priority: S('high|normal|low'), enabled: B('是否启用'),
    },
    required: ['kind'],
    handler: (args) => ({ ok: true, rule: repos.monitor.createRule(args) }),
  }))

  add(makeTool({
    name: 'career_monitor_run',
    description: '立即执行监控（串行、有节流）。返回每条规则的运行结果、耗时与错误；同时把超过时限未核验的岗位标为 STALE。',
    params: { ruleId: S('只跑某条规则（可选）'), kinds: SA('按类型过滤') },
    async handler(args) {
      if (args.ruleId) {
        const result = await monitor.runRule(String(args.ruleId))
        return { ok: true, result }
      }
      const result = await monitor.runAll({ kinds: args.kinds })
      return { ok: true, ...result }
    },
  }))

  add(makeTool({
    name: 'career_notifications',
    description: '读取提醒（未读优先）。每条含变化内容、为什么相关、来源、核验时间与建议动作。',
    params: { unreadOnly: B('只看未读'), limit: N('条数'), markRead: B('读取后标记已读') },
    handler: (args) => {
      const rows = repos.monitor.listNotifications({ unreadOnly: args.unreadOnly === true, limit: args.limit ?? 30 })
      if (args.markRead === true) for (const r of rows) repos.monitor.markNotification(r.id, { read: true })
      return { ok: true, count: rows.length, notifications: rows }
    },
  }))

  add(makeTool({
    name: 'career_digest',
    description: '今日摘要：临近截止、新入库岗位、在招高匹配岗位、待办与统计。每日/每周汇报用它。',
    params: {},
    handler: () => ({ ok: true, digest: monitor.buildDigest() }),
  }))

  // ── 校招作战计划 ───────────────────────────────────────────────────────────
  const gatherPlanInputs = () => {
    const profile = repos.profile.get()
    const completeness = repos.profile.completeness()
    const bands = new Map(repos.db.all('SELECT job_id, band FROM match_result').map((r) => [r.job_id, r.band]))
    const jobs = repos.jobs.listJobs({ limit: 500 }, profile).map((j) => ({ ...j, band: bands.get(j.id) ?? null }))
    const applications = repos.applications.list({ limit: 500 })
    const followUps = repos.applications.followUps()
    const events = repos.intel.listEvents({ limit: 100 })
    return { profile, completeness, jobs, applications, followUps, events }
  }

  add(makeTool({
    name: 'career_plan',
    description: '春招/秋招时间线 + 个性化行动清单：按你的毕业年份推算当前处在提前批/正式批/补录/春招哪个阶段、还剩多少天，并结合画像完成度、岗位池、在投数量、临近截止与逾期跟进给出按优先级排序的动作。数字取自本机数据，画像一变结论就变。',
    params: { date: S('可选：以哪天为基准推算，YYYY-MM-DD，默认今天') },
    handler: (args) => {
      const inputs = gatherPlanInputs()
      const plan = buildPlan({ ...inputs, now: str(args.date, 10) ?? today() })
      return {
        ok: true,
        ...plan,
        rules: plan.timeline ? seasonRuleSet(inputs.profile.grad_year) : null,
        note: '窗口是行业常规节奏（经验值）；公司官方节点请用 career_event_add 登记后会自动排进动作清单。',
      }
    },
  }))

  add(makeTool({
    name: 'career_event_add',
    description: '登记一个校招时间线节点（提前批开启、网申截止、笔试、面试、发 offer、入职）。source=official 表示官方公告，user 表示你自己填的，estimate 是估计——三者会在计划里区分显示。',
    params: {
      title: S('节点标题，如「字节跳动 2027 秋招网申截止」'),
      startsAt: S('开始日期 YYYY-MM-DD（必填）'),
      endsAt: S('结束日期 YYYY-MM-DD'),
      season: S('autumn_campus | spring_campus | summer | daily'),
      stage: S('apply_open | apply_close | written_test | interview | offer | onboard'),
      company: S('公司名'), companyId: S('公司 id'),
      source: S('official | user | estimate，默认 user'),
      sourceUrl: S('公告链接'), evidenceLevel: S('A|B|C|D|U'), note: S('备注'),
    },
    required: ['title', 'startsAt'],
    handler: (args) => ({ ok: true, event: repos.intel.addEvent(args) }),
  }))

  add(makeTool({
    name: 'career_unit_upsert',
    description: '建立/更新业务部门档案：这个部门负责什么业务、是核心/增长/支撑/收缩、有多少人、有哪些增长信号与风险。用于判断「这个岗位在不在核心业务上」。',
    params: {
      name: S('部门名称（必填）'),
      company: S('公司名'), companyId: S('公司 id'),
      business: S('这个部门负责的业务方向'),
      strategicRole: S('core | growth | support | declining'),
      headcountNote: S('规模/招人情况（有公开依据才填）'),
      growthSignals: { type: 'array', items: { type: 'object' }, description: '[{claim, source, asOf, level}]' },
      risks: { type: 'array', items: { type: 'object' }, description: '[{claim, source, asOf, level}]' },
      dataAsOf: S('数据时点 YYYY-MM-DD'),
    },
    required: ['name'],
    handler: (args) => ({ ok: true, unit: repos.intel.upsertUnit(args) }),
  }))

  add(makeTool({
    name: 'career_outlook_add',
    description: '登记一条市场/行业/公司/部门前景信号（一条断言 + 一条来源 + 证据等级 + 时限）。用于「结合市场情况、未来发展前景」做分析——必须带来源与日期，没有依据的不要写成结论。',
    params: {
      claim: S('一句话断言，必须可核对（必填）'),
      scope: S('industry | company | unit'),
      topic: S('需求 | 政策 | 技术 | 竞争 | 资本 | 人才'),
      direction: S('positive | neutral | negative'),
      horizon: S('0-6m | 6-18m | 18m+'),
      industryId: S('关联行业 id'), companyId: S('关联公司 id'), unitId: S('关联部门 id'),
      evidenceLevel: S('A 官方一手 | B 多源印证 | C 单一可溯源 | D 未证实 | U 信息不足'),
      source: S('来源名称，如「公司财报」「工信部统计」'),
      sourceUrl: S('来源链接'), asOf: S('数据时点 YYYY-MM-DD'),
    },
    required: ['claim'],
    handler: (args) => ({ ok: true, signal: repos.intel.addSignal(args) }),
  }))

  add(makeTool({
    name: 'career_plan_brief',
    description: '生成一份综合分析简报（Markdown 并入库）：春招秋招时间线与当前阶段、你的画像与求职意愿、岗位池优先级与投递地址、招聘门槛分层、市场与行业前景、业务部门与成长、未知与待核实清单、未来 4 周动作。缺数据的部分会明确列在「未知」，不会编。',
    params: {
      save: B('是否存入研究简报库，默认 true'),
      industryId: S('可选：聚焦某个行业的前景信号'),
      companyId: S('可选：聚焦某家公司的部门与前景'),
    },
    handler: (args) => {
      const inputs = gatherPlanInputs()
      const now = today()
      const plan = buildPlan({ ...inputs, now })
      const signals = repos.intel.listSignals({
        industryId: args.industryId, companyId: args.companyId, limit: 300,
      })
      const units = repos.intel.listUnits({ companyId: args.companyId })
      const bar = repos.intel.barFor({ companyId: args.companyId })
      const brief = buildBrief({
        profile: inputs.profile,
        completeness: inputs.completeness,
        plan,
        jobs: inputs.jobs,
        applications: inputs.applications,
        signals,
        units,
        bar,
        now,
      })
      let reportId = null
      if (args.save !== false) {
        const report = repos.intel.saveReport({
          kind: 'summary',
          title: `求职作战计划 ${now}`,
          body: brief.markdown,
          sources: [...new Set(signals.map((s) => s.source).filter(Boolean))].slice(0, 20),
          dataAsOf: now,
          companyId: args.companyId ?? null,
        })
        reportId = report.id
        panel.publish({ kind: 'reports', id: reportId })
      }
      return {
        ok: true,
        reportId,
        markdown: brief.markdown,
        missing: brief.missing,
        stats: brief.stats,
        evidenceRule: 'A/B 级才可作为结论依据；C 级仅供参考；D/U 必须标注不确定。时间为行业常规节奏（经验值）。',
      }
    },
  }))

  // ── feedback & panel ───────────────────────────────────────────────────────
  add(makeTool({
    name: 'career_feedback',
    description: '对岗位/数据源/匹配结果反馈（interested/not_interested/wrong/stale/applied/disqualified/research），用于调整排序与改进数据质量。',
    params: { subjectType: S('job|source|match|company'), subjectId: S('对象 id'), verdict: S('interested|not_interested|wrong|stale|applied|disqualified|research'), note: S('说明') },
    required: ['subjectType', 'subjectId', 'verdict'],
    handler: (args) => ({ ok: true, feedback: repos.monitor.addFeedback(args), summary: repos.monitor.feedbackSummary() }),
  }))

  add(makeTool({
    name: 'career_panel',
    description: '让用户在 CareerOS 面板里看到指定页面（并可选聚焦某个岗位/公司）。对话里给出结论后调用它，用户才知道去哪看。',
    params: { tab: S('overview|plan|resume|industry|radar|company|social|tracker|interview|settings'), code: S('聚焦的岗位/公司 id'), note: S('一句话说明为什么看这里') },
    required: ['tab'],
    handler: (args) => {
      const payload = { tab: String(args.tab), code: args.code ? String(args.code) : null, note: str(args.note, 200), at: nowIso() }
      panel.publish({ kind: 'navigate', ...payload })
      return { ok: true, navigated: payload, note: '面板已切换；如果用户没打开面板，用一句话告诉他点侧边栏的「求职面板」。' }
    },
  }))

  add(makeTool({
    name: 'career_export',
    description: '导出数据为 JSON（可指定范围），返回文件路径。用于备份或迁移。',
    params: { scope: S('all|jobs|applications|profile|research'), format: S('json（默认）') },
    handler: (args) => ({ ok: true, ...deps.exporter.exportData(String(args.scope ?? 'all')) }),
  }))

  logger.info('career tools registered', { count: registered.length })
  return registered
}
