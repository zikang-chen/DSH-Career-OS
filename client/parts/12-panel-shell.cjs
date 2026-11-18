// ─── panel shell ─────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview', label: '总览', icon: '◱' },
  { key: 'plan', label: '秋招计划', icon: '◷' },
  { key: 'resume', label: '我的画像', icon: '◧' },
  { key: 'studio', label: '简历中心', icon: '◨' },
  { key: 'radar', label: '岗位列表', icon: '◈' },
  { key: 'tracker', label: '投递管理', icon: '☰' },
  { key: 'company', label: '公司情报', icon: '◉' },
  { key: 'industry', label: '行业研究', icon: '◎' },
  { key: 'social', label: '情报中心', icon: '◔' },
  { key: 'interview', label: '面试准备', icon: '◐' },
  { key: 'settings', label: '设置', icon: '⚙' },
]

/**
 * 5 个工作区：把 11 个页签归组，但**每个原有页签都还在**（没有删除任何功能）。
 * 这样左侧导航从 11 行压到 5 组，找人找事更快；老入口点一下仍然是原来那个页面。
 */
const WORKSPACES = [
  { key: 'home', label: '总览', hint: '今天做什么', tabs: ['overview', 'plan'] },
  { key: 'opportunities', label: '找岗位', hint: '浏览岗位与公司背景', tabs: ['radar', 'company', 'industry'] },
  { key: 'applications', label: '我的投递', hint: '跟进岗位、准备面试', tabs: ['tracker', 'interview'] },
  { key: 'resume', label: '我的材料', hint: '真实经历、简历与参考资料', tabs: ['studio', 'social'] },
  { key: 'settings', label: '设置', hint: '数据源与系统', tabs: ['resume', 'settings'] },
]
