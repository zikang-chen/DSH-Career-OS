// 「抓不到也要给出精确位置」的取数指引。
//
// 目标：当系统无法自动获取时，用户拿到的不是一句"抓不到"，而是一份可以直接照做的
// 说明——打开哪个网址、点哪里、复制什么、粘回哪个地方。
import { ATS_SPECS, detectAts } from './ats.js'
import { suggestSocialQueries } from './sources.js'
import { companyKey, str } from './util.js'

/** 已知雇主的招聘入口候选（仅作为起点，用户可改）。 */
const KNOWN_CAREERS = {
  字节跳动: ['https://jobs.bytedance.com/campus', 'https://jobs.bytedance.com/experienced'],
  腾讯: ['https://join.qq.com/', 'https://careers.tencent.com/'],
  阿里巴巴: ['https://talent.alibaba.com/campus/home', 'https://talent.alibaba.com/off-campus-position'],
  蚂蚁集团: ['https://talent.antgroup.com/'],
  美团: ['https://zhaopin.meituan.com/web/position', 'https://campus.meituan.com/'],
  百度: ['https://talent.baidu.com/jobs/list', 'https://talent.baidu.com/jobs/campus'],
  京东: ['https://zhaopin.jd.com/web/job/job_info_list/3', 'https://campus.jd.com/'],
  快手: ['https://zhaopin.kuaishou.cn/recruit/e/offical/#/official/index'],
  网易: ['https://hr.163.com/job-list.html', 'https://campus.163.com/'],
  小米: ['https://hr.xiaomi.com/campus', 'https://hr.xiaomi.com/social'],
  华为: ['https://career.huawei.com/reccampportal/portal5/index.html'],
  拼多多: ['https://careers.pinduoduo.com/campus'],
  小红书: ['https://job.xiaohongshu.com/campus', 'https://job.xiaohongshu.com/social'],
  哔哩哔哩: ['https://jobs.bilibili.com/campus', 'https://jobs.bilibili.com/social'],
  滴滴: ['https://talent.didiglobal.com/'],
  联想: ['https://jobs.lenovo.com/'],
  中国平安: ['https://campus.pingan.com/'],
  招商银行: ['https://career.cmbchina.com/'],
  中金公司: ['https://careers.cicc.com/'],
  德勤: ['https://www.deloitte.com/cn/en/careers.html'],
  普华永道: ['https://www.pwccn.com/zh/careers.html'],
}

/**
 * Build a copy-paste-able retrieval guide.
 * @param {object} input
 * @param {string} [input.company]
 * @param {string} [input.url] 已知的招聘页地址
 * @param {string} [input.role]
 * @param {number} [input.year]
 * @returns {object}
 */
export function buildRetrievalGuide({ company, url, role, year, careersUrl } = {}) {
  const steps = []
  const copyable = []
  let order = 1
  const addStep = (title, detail, copy) => {
    steps.push({ order: order++, title, detail, copy: copy ?? null })
    if (copy) copyable.push({ label: title, url: copy })
  }

  const detected = url ? detectAts(url) : null
  const knownUrls = []
  const key = companyKey(company ?? '')
  if (careersUrl) knownUrls.push(str(careersUrl, 1000))
  if (url) knownUrls.push(str(url, 1000))
  if (key && KNOWN_CAREERS[company ?? ''] ) {
    for (const candidate of KNOWN_CAREERS[company]) if (!knownUrls.includes(candidate)) knownUrls.push(candidate)
  } else if (key) {
    // Match by normalized key so `北京字节跳动科技有限公司` still hits 字节跳动.
    for (const [name, urls] of Object.entries(KNOWN_CAREERS)) {
      if (companyKey(name) === key) {
        for (const candidate of urls) if (!knownUrls.includes(candidate)) knownUrls.push(candidate)
        break
      }
    }
  }

  let ats = null
  if (detected) {
    const apiUrl = detected.spec.api(detected.token)
    ats = {
      ats: detected.ats,
      label: detected.spec.label,
      token: detected.token,
      apiUrl,
      docUrl: detected.spec.docUrl,
      hint: detected.spec.hint,
    }
    addStep(
      `这家公司用的是 ${detected.spec.label}，直接抓它的公开接口`,
      `${detected.spec.label} 的对外的只读岗位接口不需要登录。把下面这个地址粘进 career_jobs_crawl 的 urls 就能直接入库。`,
      apiUrl,
    )
    addStep('如果你看到的地址长这样', detected.spec.hint, null)
  } else {
    addStep(
      '第一步：打开它的招聘官网',
      knownUrls.length
        ? '下面这些是从你给的信息推断出的候选入口，先打开最像的那个。'
        : '先确定公司招聘官网地址（一般搜「<公司名> 招聘官网」第一条就是官方域名）。',
      knownUrls[0] ?? null,
    )
    if (knownUrls.length > 1) {
      for (const candidate of knownUrls.slice(1)) copyable.push({ label: '候选入口', url: candidate })
    }
    addStep(
      '第二步：确认这个页面是「列表页」而不是首页',
      '要找的是能看到一屏岗位卡片、有筛选条件的那个页面（校招通常是 /campus、/campus/home、/jobs/list）。首页轮播图那种不算。',
      null,
    )
    addStep(
      '第三步：抓它的数据接口（纯前端站点只有这一步能拿到岗位）',
      '在这个列表页按 F12 → 打开 Network（网络）面板 → 选 Fetch/XHR → 按 Ctrl+R 刷新页面 → 在列表里找名字带 job / position / list / search / campus 的请求 → 点开看 Response 是不是一坨 JSON、里面有岗位名。找到后右键该请求 → Copy → Copy link address。',
      null,
    )
    addStep(
      '第四步：把那个接口地址粘回来',
      '直接调用 career_jobs_crawl，urls 填刚复制的接口地址，company 填公司名。系统会按 JSON 解析，自动带出岗位名、地点、投递地址。',
      null,
    )
    addStep(
      '实在找不到接口时的兜底',
      '在列表页全选（Ctrl+A）复制，或把单个岗位的 JD 页面复制，粘到面板「岗位雷达 → 新增岗位」的 JD 原文里，系统会解析成结构化岗位。',
      null,
    )
  }

  const social = suggestSocialQueries({ company, role, year })
  const pasteTemplate = [
    `公司：${company ?? ''}`,
    '接口或页面地址：（把上面复制到的地址粘这里）',
    '岗位范围：如 2027 届校招 / 实习',
    '备注：看不到岗位时说明一下（例如需要登录、只显示境外岗位）',
  ].join('\n')

  return {
    company: company ?? null,
    targetUrl: url ?? knownUrls[0] ?? null,
    detectedAts: ats,
    knownEntries: knownUrls,
    steps,
    copyableUrls: copyable,
    socialQueries: social.queries,
    socialLinks: social.links,
    pasteTemplate,
    atsCatalog: Object.entries(ATS_SPECS).map(([key, spec]) => ({
      ats: key, label: spec.label, docUrl: spec.docUrl, hint: spec.hint,
    })),
    note: [
      '自动抓取只走公开、免登录、robots 允许的页面与官方只读接口。',
      '需要登录或明确禁止自动化采集的平台（小红书/脉脉/BOSS/实习僧等）不做自动抓取，只能你手动取回内容。',
      '凡是拿不到的字段一律留空并标注，不会编造岗位。',
    ].join(''),
  }
}

/** Short version used inline when a crawl fails, so the caller is never left hanging. */
export function guideInline({ company, url }) {
  const guide = buildRetrievalGuide({ company, url })
  return {
    detectedAts: guide.detectedAts,
    copyableUrls: guide.copyableUrls.slice(0, 6),
    steps: guide.steps.slice(0, 3).map((s) => `[${s.order}] ${s.title}：${s.detail}`),
    pasteTemplate: guide.pasteTemplate,
  }
}
