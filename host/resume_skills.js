// 简历优化 skill 库：把「杂乱经历 → 对应 JD 的简历」拆成可执行的方法论 + 确定性诊断。
//
// 边界（最重要）：只做「诊断 + 改写建议」，**绝不新造成果**。
//   - 有数字 → 建议前置；没数字 → 只提示「有真实数据再补」，不替编。
//   - 弱动词（负责/参与/协助）→ 建议换成更强的词，但标「需确认语义未变」。
//   - JD 关键词没覆盖 → 列出来，让你判断是否真的具备，而不是自动塞进去。
//
// 方法论来源（行业通行做法，非编造研究）：
//   - Google XYZ 公式：Accomplished [X] as measured by [Y] by doing [Z]
//   - STAR：Situation / Task / Action / Result
//   - ATS 关键词对齐：把 JD 的用词映射到简历措辞
//   - 一页原则与要点密度控制
import { extractSkills } from './domain.js'

export const RESUME_SKILLS = [
  {
    id: 'xyz', name: 'XYZ 成果公式', category: '结构',
    when: '要点只有职责、看不出结果时',
    how: '按「做成了什么（X）→ 用什么指标衡量（Y）→ 怎么做（Z）」重写，把成果与量化放前面。',
    checks: ['每条要点有动词+对象+结果', '结果能量化就量化'],
    example: { before: '负责用户增长相关工作', after: '把新用户次留从 X% 提到 Y%（Z 手段），覆盖 N 万用户', note: '示例，数字需用你自己的真实数据' },
  },
  {
    id: 'star', name: 'STAR 结构', category: '结构',
    when: '项目/实习要点零散、说不清你个人做了什么',
    how: '补全「背景—任务—你的动作—结果」，尤其是「你个人」的动作与结果，而不是团队整体。',
    checks: ['有明确个人贡献', '有可验证结果'],
    example: { before: '参与了某系统开发', after: '针对 XX 场景（S/T），我主导了 XX 模块（A），使 XX 指标从 a 到 b（R）', note: '示例' },
  },
  {
    id: 'quantify', name: '量化优先', category: '表达',
    when: '要点没有任何数字',
    how: '把规模、效率、增长、成本、准确率等真实数据前置；没有真实数据就不要编，先留空待补。',
    checks: ['至少一条要点含量化', '数字来源可解释'],
    example: { before: '优化了系统性能', after: 'P95 延迟降低 38%（X→Y ms），吞吐提升 1.7×', note: '示例，务必用实测值' },
  },
  {
    id: 'strong-verb', name: '强动词开头', category: '表达',
    when: '要点以「负责/参与/协助/帮助」开头',
    how: '换成能体现主导性的动词（主导/搭建/推动/设计/验证/落地），但要确认语义没被夸大。',
    checks: ['动词体现你的实际角色', '不把「参与」写成「主导」'],
    example: { before: '参与需求分析', after: '独立完成 XX 场景需求分析，输出 PRD 并推动评审通过', note: '示例，仅当确实独立完成时使用' },
  },
  {
    id: 'jd-align', name: 'JD 关键词对齐', category: '匹配',
    when: '投不同岗位还在用同一版措辞',
    how: '把 JD 里的核心词（技能/职责/指标）映射到你的真实经历措辞；具备才写，不具备列为缺口。',
    checks: ['JD 核心技能在简历中有对应表述', '缺的不要硬凑'],
    example: { before: '做过数据相关工作', after: '用 SQL 做漏斗与留存分析，支撑 A/B 实验结论', note: '示例，前提是你真的做过' },
  },
  {
    id: 'translate', name: '科研/校园 → 岗位语言', category: '匹配',
    when: '学术或校园经历与目标岗位语言不通',
    how: '把论文/实验翻译成「问题—方案—可验证结果—业务含义」；把社团/副业翻译成「运营—转化—复购」。',
    checks: ['术语向目标岗位靠拢', '保留可验证数据'],
    example: { before: '在实验室研究联邦学习', after: '面向隐私约束设计单轮联邦方案，在较小隐私预算下保持精度（可扩展到 XX 场景）', note: '示例' },
  },
  {
    id: 'trim', name: '精简与一页原则', category: '版式',
    when: '一段经历要点过多、单条太长',
    how: '每段保留 3 条最相关要点；单条控制在一到两行；删掉与 JD 无关的细节。',
    checks: ['每段 ≤ 3-4 条', '单条 ≤ 2 行'],
    example: { before: '（一条 5 行的长句）', after: '（拆成一条，一句一个结果）', note: '示例' },
  },
  {
    id: 'gap-honesty', name: '缺口诚实表达', category: '匹配',
    when: 'JD 要求你没有的东西',
    how: '列为缺口并给补强计划；不要用模糊措辞假装具备。面试也会被追问穿。',
    checks: ['缺口明确列出', '给出可执行补强'],
    example: { before: '（把没做过的写成做过）', after: '缺口：无 A/B 实验经验 → 计划用 XX 数据集做一次完整实验', note: '示例' },
  },
]

const WEAK_VERBS = ['负责', '参与', '协助', '帮助', '配合', '参加']
const RESULT_HINT = /(提升|降低|减少|增长|达到|实现|从.+到|节省|覆盖|转化|留存|准确率|延迟|吞吐|效率)/

function hasMetric(text) {
  return /\d+(\.\d+)?\s*(%|万|亿|倍|×|人|天|小时|篇|项|个|款|次|ms|s\b)/i.test(String(text ?? '')) || /\d+\s*\/\s*\d+/.test(String(text ?? ''))
}

/** 分析一组要点，给出可执行建议（不生成内容）。 */
export function analyzeBullets({ bullets = [], jdText = '' } = {}) {
  const perBullet = bullets.map((raw) => {
    const bullet = String(raw ?? '').trim()
    const issues = []
    const skillIds = []
    if (!bullet) return { bullet, issues: ['空要点'], skillIds: [] }
    if (!hasMetric(bullet)) { issues.push('缺量化（有真实数据再补，别编）'); skillIds.push('quantify') }
    if (WEAK_VERBS.some((v) => bullet.startsWith(v))) { issues.push('弱动词开头（负责/参与/协助）'); skillIds.push('strong-verb') }
    if (!RESULT_HINT.test(bullet)) { issues.push('看不出结果'); skillIds.push('xyz') }
    if (bullet.length > 80) { issues.push('单条偏长，建议压到 2 行内'); skillIds.push('trim') }
    return { bullet, issues, skillIds: [...new Set(skillIds)] }
  })

  // JD 关键词覆盖：只从 JD 里抽取技能词，检查要点里有没有出现
  const jdKeywords = [...new Set(extractSkills(String(jdText ?? '')))]
  const joined = bullets.join('\n').toLowerCase()
  const covered = jdKeywords.filter((k) => joined.includes(String(k).toLowerCase()))
  const missing = jdKeywords.filter((k) => !joined.includes(String(k).toLowerCase()))

  const needTrim = perBullet.filter((b) => b.skillIds.includes('trim')).length
  const recommended = new Set(perBullet.flatMap((b) => b.skillIds))
  if (jdKeywords.length) recommended.add('jd-align')
  if (missing.length) recommended.add('gap-honesty')

  const skills = RESUME_SKILLS.filter((s) => recommended.has(s.id) || s.id === 'star')
  return {
    skills,
    perBullet,
    jdCoverage: {
      keywords: jdKeywords,
      covered,
      missing,
      note: jdKeywords.length
        ? `JD 里有 ${jdKeywords.length} 个技能词，简历要点覆盖 ${covered.length} 个；缺的请确认是否真的具备，不要硬凑。`
        : '没提供 JD 文本，无法做关键词对齐。',
    },
    summary: {
      bullets: bullets.length,
      needQuantify: perBullet.filter((b) => b.skillIds.includes('quantify')).length,
      weakVerb: perBullet.filter((b) => b.skillIds.includes('strong-verb')).length,
      needTrim,
      missingKeywords: missing.length,
    },
    caveats: [
      '只给诊断与改写方向，不替你新造成果或数字。',
      '强动词替换前请确认语义没被夸大（参与 ≠ 主导）。',
      '方法论为行业通行做法（XYZ / STAR / ATS 关键词对齐 / 一页原则），非实证研究。',
    ],
  }
}
