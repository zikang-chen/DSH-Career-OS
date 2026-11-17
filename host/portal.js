// 公司 → 校招官网地址：把「我要投腾讯」变成「打开哪个网址、登录后我抓」。
//
// 两个原则：
//   1. 不凭记忆断言 URL 可用——每家给 2~4 个候选，现场探测哪个真的能打开（200 + 像招聘页），
//      把探测结果和探测时间一起返回。打不开就说打不开，不硬编。
//   2. 国内大厂校招站几乎都是 SPA，URL 背后的接口各不相同，所以这里只解决「去哪个门」，
//      进门之后的取数交给专用浏览器（career_browser_login + career_browser_capture）。
import { companyKey } from './util.js'

/**
 * 候选校招入口。alias 用于匹配用户说法（腾讯 / 鹅厂 / tencent）。
 * 顺序即优先级：越靠前越可能是当前在用的校招主站。
 */
export const CAMPUS_PORTALS = [
  {
    name: '字节跳动',
    aliases: ['字节', 'bytedance', '抖音', 'tiktok'],
    urls: ['https://jobs.bytedance.com/campus', 'https://jobs.bytedance.com/experienced'],
    apiHint: 'GET /api/v1/search/job/posts?portal_type=3&limit=10&offset=0（响应 data.job_post_list，含 description/requirement）',
    verifiedBy: 'career_browser_capture 实测可抓',
  },
  {
    name: '腾讯',
    aliases: ['tencent', '鹅厂'],
    urls: ['https://join.qq.com', 'https://join.qq.com/index.html', 'https://careers.tencent.com'],
    apiHint: '校招站为 SPA；登录后在岗位列表用 career_browser_capture，会自动找 XHR',
  },
  {
    name: '阿里巴巴',
    aliases: ['阿里', 'alibaba', '淘天', '阿里云'],
    urls: ['https://talent.alibaba.com/campus', 'https://talent.alibaba.com', 'https://campus.alibaba.com'],
  },
  {
    name: '蚂蚁集团',
    aliases: ['蚂蚁', 'antgroup', '支付宝'],
    urls: ['https://talent.antgroup.com/campus', 'https://talent.antgroup.com'],
  },
  {
    name: '美团',
    aliases: ['meituan', '美团点评'],
    urls: ['https://zhaopin.meituan.com/campus', 'https://zhaopin.meituan.com'],
  },
  {
    name: '百度',
    aliases: ['baidu'],
    urls: ['https://talent.baidu.com/jobs/campus', 'https://talent.baidu.com'],
  },
  {
    name: '京东',
    aliases: ['jd', '京东集团'],
    urls: ['https://campus.jd.com', 'https://zhaopin.jd.com/campus', 'https://zhaopin.jd.com'],
  },
  {
    name: '快手',
    aliases: ['kuaishou', 'ks'],
    urls: ['https://zhaopin.kuaishou.cn', 'https://zhaopin.kuaishou.cn/recruit/e/'],
  },
  {
    name: '拼多多',
    aliases: ['pdd', 'pinduoduo'],
    urls: ['https://careers.pinduoduo.com/campus', 'https://careers.pinduoduo.com'],
  },
  {
    name: '网易',
    aliases: ['netease', '网易游戏'],
    urls: ['https://hr.163.com/campus.html', 'https://hr.163.com'],
  },
  {
    name: '小米',
    aliases: ['xiaomi', '小米集团'],
    urls: ['https://hr.xiaomi.com/campus', 'https://hr.xiaomi.com'],
  },
  {
    name: '华为',
    aliases: ['huawei'],
    urls: ['https://career.huawei.com/reccampportal/portal5/campus-recruitment.html', 'https://career.huawei.com'],
  },
  {
    name: '大疆',
    aliases: ['dji'],
    urls: ['https://we.dji.com/zh-CN/campus', 'https://we.dji.com'],
  },
  {
    name: '哔哩哔哩',
    aliases: ['bilibili', 'b站', 'B站'],
    urls: ['https://jobs.bilibili.com/campus', 'https://jobs.bilibili.com'],
  },
  {
    name: '微软',
    aliases: ['microsoft', 'ms'],
    urls: ['https://careers.microsoft.com/students', 'https://jobs.careers.microsoft.com/global/en/search'],
  },
]

/** 用户说法 → 门户配置；认不出返回 null（交给搜索指引）。 */
export function resolvePortal(name) {
  const key = companyKey(String(name ?? ''))
  if (!key) return null
  const raw = String(name ?? '').toLowerCase()
  for (const portal of CAMPUS_PORTALS) {
    const names = [portal.name, ...(portal.aliases ?? [])].map((item) => String(item).toLowerCase())
    if (names.some((item) => item && (raw === item || raw.includes(item) || companyKey(item) === key))) {
      return portal
    }
  }
  return null
}

function looksLikeCareersPage(html, title) {
  const head = `${title ?? ''}\n${String(html ?? '').slice(0, 20000)}`
  return /校招|校园招聘|campus|recruit|招聘|jobs?/i.test(head)
}

/**
 * 现场探测哪几个候选地址真的能打开。
 * 只做 GET，每个候选一次，串行，超时 12s。
 */
export async function probePortals(portal, { timeoutMs = 12000, gapMs = 400 } = {}) {
  const results = []
  for (const url of portal.urls ?? []) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      })
      const text = (await response.text()).slice(0, 60000)
      const title = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(text)?.[1]?.trim() ?? null
      results.push({
        url,
        status: response.status,
        ok: response.ok && looksLikeCareersPage(text, title),
        title,
        bytes: text.length,
        note: response.ok ? (looksLikeCareersPage(text, title) ? '可打开，像招聘页' : '可打开，但不像招聘页') : `HTTP ${response.status}`,
      })
    } catch (err) {
      results.push({ url, status: 0, ok: false, title: null, bytes: 0, note: controller.signal.aborted ? '超时' : String(err?.message ?? err).slice(0, 80) })
    } finally {
      clearTimeout(timer)
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
  }
  const best = results.find((row) => row.ok) ?? results.find((row) => row.status === 200) ?? null
  return {
    results,
    best: best?.url ?? null,
    reachable: results.some((row) => row.ok),
  }
}
