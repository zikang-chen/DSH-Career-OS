// 给一段 JD，产出「可能的面试问题 + 知识点」。
//
// 两条铁律：
//   1. 生成的问题一律标 ai-practice（AI 练习方向），**绝不冒充真实面经**；
//      真实面经只来自 career_forum_import 导入的资料（证据 C，样本有限）。
//   2. 知识点只从「JD 里实际出现的词」推导；JD 没提的方向不编，列进「JD 未覆盖」。
//
// 不联网、不调用模型：关键词→知识点是一张固定表，确定性、可测试。

/** 关键词 → 知识点 + 常见考察方向。match 为正则，用于在 JD 文本里找。 */
export const KNOWLEDGE_MAP = [
  {
    key: 'sql', match: /sql|数据库|mysql|查询/i, topic: '数据库与 SQL',
    points: ['索引结构与最左前缀', '执行计划与慢查询定位', '多表 JOIN 与子查询', '窗口函数', '事务与隔离级别'],
    questions: [
      '一条慢查询你会怎么定位和优化？',
      '索引为什么有时用不上？最左前缀指什么？',
      '窗口函数和 GROUP BY 的区别，举一个业务场景。',
    ],
  },
  {
    key: 'python', match: /python/i, topic: 'Python',
    points: ['GIL 与多线程/多进程', '生成器与迭代器', '装饰器', '内存管理与引用计数', '常用数据结构复杂度'],
    questions: ['Python 的 GIL 对并发有什么影响？你怎么绕过？', '生成器和列表推导在内存上有什么区别？'],
  },
  {
    key: 'java', match: /\bjava\b/i, topic: 'Java / JVM',
    points: ['JVM 内存模型', 'GC 与调优', '并发包与锁', '集合源码', 'Spring 生命周期'],
    questions: ['JVM 内存分区和一次 Full GC 的触发条件？', 'synchronized 与 ReentrantLock 的区别？'],
  },
  {
    key: 'algo', match: /算法|数据结构|leetcode|复杂度/i, topic: '算法与数据结构',
    points: ['数组/链表/栈/队列', '哈希表', '二叉树遍历', '动态规划', '排序与二分'],
    questions: ['手写一个 LRU？', '这道题的时间/空间复杂度是多少，能再优化吗？'],
  },
  {
    key: 'ml', match: /机器学习|machine learning|模型训练|特征工程/i, topic: '机器学习',
    points: ['偏差-方差权衡', '过拟合与正则', '特征工程', '评估指标（AUC/F1）', '样本不均衡'],
    questions: ['AUC 的物理含义？样本极不均衡时它还好用吗？', '过拟合怎么判断、怎么缓解？'],
  },
  {
    key: 'dl', match: /深度学习|神经网络|cnn|rnn|transformer|attention/i, topic: '深度学习',
    points: ['反向传播', 'Transformer 与注意力机制', '归一化与残差', '损失函数选择', '训练稳定性'],
    questions: ['自注意力的计算复杂度是多少，怎么降？', 'LayerNorm 和 BatchNorm 的区别？'],
  },
  {
    key: 'llm', match: /大模型|llm|大语言模型|微调|finetune|lora|推理优化|量化/i, topic: '大模型与推理',
    points: ['Transformer/上下文窗口', 'LoRA 等参数高效微调', '量化与显存', 'KV Cache 与批处理', '幻觉与评测'],
    questions: [
      'LoRA 为什么能省显存？rank 怎么选？',
      '推理时 P95 延迟高，你会从哪些层面排查？',
      '大模型的幻觉你怎么评估和缓解？',
    ],
  },
  {
    key: 'rag', match: /\brag\b|检索增强|向量检索|知识库/i, topic: 'RAG / 检索增强',
    points: ['文档切分策略', '召回与重排', '向量库与相似度', '幻觉抑制', '端到端评测'],
    questions: ['RAG 召回不准你会怎么改？', '怎么评估一个 RAG 系统好不好？'],
  },
  {
    key: 'agent', match: /agent|智能体|tool use|planning|memory/i, topic: 'Agent / 智能体',
    points: ['Tool Use 与函数调用', 'Planning 与任务分解', 'Memory 与上下文管理', '多智能体协作', '失败重试与兜底'],
    questions: ['Agent 调用工具失败时你怎么设计兜底？', '长任务的上下文怎么管理？'],
  },
  {
    key: 'recsys', match: /推荐系统|推荐算法|召回|排序/i, topic: '推荐系统',
    points: ['召回/粗排/精排', '特征与样本', '冷启动', '线上 AB 与指标', '多目标优化'],
    questions: ['推荐冷启动你会怎么做？', '召回和排序分别关注什么指标？'],
  },
  {
    key: 'data', match: /数据分析|指标体系|漏斗|留存|ab测试|a\/b/i, topic: '数据分析与实验',
    points: ['指标体系搭建', '漏斗与留存分析', 'AB 实验设计与显著性', '归因与同期群', '指标异常排查'],
    questions: ['某个核心指标突然下降，你怎么排查？', 'AB 实验多久能得出结论？样本量怎么估？'],
  },
  {
    key: 'product', match: /产品经理|prd|需求分析|用户研究|竞品/i, topic: '产品能力',
    points: ['需求优先级（KANO/RICE）', 'PRD 与原型', '用户访谈与洞察', '指标体系与北极星指标', '跨部门推进'],
    questions: [
      '给你一个场景，你怎么排需求优先级？',
      '怎么验证一个需求是真需求还是伪需求？',
      '和研发对工期有分歧时你怎么推进？',
    ],
  },
  {
    key: 'growth', match: /增长|运营|拉新|留存|转化|私域/i, topic: '增长与运营',
    points: ['AARRR 模型', '拉新渠道与成本', '留存曲线', '转化漏斗优化', '内容与社群运营'],
    questions: ['如果让你三个月把某功能 DAU 翻倍，你怎么拆解？', '你怎么衡量一次运营活动的 ROI？'],
  },
  {
    key: 'dist', match: /分布式|微服务|消息队列|缓存|redis|kafka|高并发/i, topic: '分布式与后端',
    points: ['缓存一致性与穿透', '消息队列削峰/幂等', '分布式锁', '服务拆分与治理', '限流熔断'],
    questions: ['缓存和数据库不一致怎么处理？', '消息重复消费怎么保证幂等？'],
  },
  {
    key: 'frontend', match: /前端|react|vue|javascript|typescript|css/i, topic: '前端',
    points: ['事件循环', '组件生命周期/状态管理', '渲染性能', '网络与缓存', '工程化'],
    questions: ['浏览器事件循环里宏任务/微任务怎么执行？', '首屏性能怎么优化？'],
  },
  {
    key: 'pm_basic', match: /项目管理|敏捷|scrum|排期|跨团队/i, topic: '项目管理',
    points: ['范围/进度/风险', '敏捷与迭代', '干系人沟通', '里程碑管理'],
    questions: ['项目延期了你怎么处理？', '跨团队协作中冲突怎么解决？'],
  },
]

/** 从 JD 文本里找出命中的知识点主题。 */
export function extractTopics(jdText) {
  const text = String(jdText ?? '')
  if (!text.trim()) return []
  const hits = []
  for (const entry of KNOWLEDGE_MAP) {
    if (entry.match.test(text)) hits.push(entry)
  }
  return hits
}

/** JD 里常出现的「年限/学历/地点」等硬信息，用于面试前核对，不生成问题。 */
export function extractJdFacts(jdText) {
  const text = String(jdText ?? '')
  const facts = {}
  const years = /(\d+)\s*年(?:以上)?(?:工作|相关)?经验/.exec(text)
  if (years) facts.experienceYears = Number(years[1])
  const edu = /(本科|硕士|博士)(?:及以上)?/.exec(text)
  if (edu) facts.degree = edu[1]
  const cities = ['北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州'].filter((c) => text.includes(c))
  if (cities.length) facts.cities = cities
  if (/每周.{0,4}(\d)\s*天/.test(text)) facts.daysPerWeek = Number(/每周.{0,4}(\d)\s*天/.exec(text)[1])
  return facts
}

/**
 * 生成面试准备方案。
 * @param {{jdText:string, title?:string, company?:string, realExperiences?:Array}} input
 */
export function buildInterviewPlan({ jdText, title, company, realExperiences = [] } = {}) {
  const text = String(jdText ?? '')
  if (!text.trim()) {
    return { ok: false, error: '没有 JD 文本：粘贴岗位描述后再分析' }
  }
  const topics = extractTopics(text)
  const facts = extractJdFacts(text)

  const knowledgePoints = topics.map((t) => ({ topic: t.topic, points: t.points }))
  const questions = []
  for (const t of topics) {
    for (const q of t.questions) {
      questions.push({ category: t.topic, question: q, source: 'ai-practice' })
    }
  }

  const realQuestions = (realExperiences ?? []).flatMap((exp) =>
    (exp.questions ?? []).map((q) => ({ question: q, source: 'imported-forum', evidenceLevel: exp.evidence_level ?? 'C', stage: exp.stage ?? null, year: exp.year ?? null })))

  const uncovered = []
  if (!topics.length) uncovered.push('JD 里没有命中任何已知考察方向——可能是纯管理岗或描述太短，建议补全 JD。')

  return {
    ok: true,
    job: { title: title ?? null, company: company ?? null },
    jdFacts: facts,
    knowledgePoints,
    questions,
    realQuestions,
    counts: { topics: topics.length, practiceQuestions: questions.length, realQuestions: realQuestions.length },
    caveats: [
      '问题与知识点是**根据 JD 关键词生成的练习方向**（标 ai-practice），不是真实面试题，也不代表公司实际会问。',
      realQuestions.length
        ? `另有 ${realQuestions.length} 条来自已导入的论坛面经（证据等级多为 C，样本有限）。`
        : '还没有导入真实面经；如需要，可用 career_forum_import 导入后会有「真实面经」区。',
      ...uncovered,
    ],
  }
}
