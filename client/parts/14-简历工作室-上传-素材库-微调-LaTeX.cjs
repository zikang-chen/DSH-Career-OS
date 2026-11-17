// ─── 简历工作室：上传 / 素材库 / 微调 / LaTeX ────────────────────────────────
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

const KIND_OPTIONS = [
  ['education', '教育背景'], ['internship', '实习经历'], ['project', '项目经历'],
  ['research', '科研经历'], ['activity', '校园经历'], ['award', '奖项荣誉'],
  ['certificate', '证书'], ['skill', '技能'],
]

function StudioTab({ onChanged, focusCode }) {
  const [view, setView] = useState(focusCode ? 'tailor' : 'upload')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // upload
  const [uploading, setUploading] = useState(false)

  // vault
  const [vault, setVault] = useState(null)
  const [draft, setDraft] = useState({ kind: 'internship', organization: '', role: '', startAt: '', endAt: '', bullets: '' })

  // tailor
  const [jobs, setJobs] = useState([])
  const [tailorJobId, setTailorJobId] = useState(focusCode || '')
  useEffect(() => { if (focusCode) { setTailorJobId(focusCode); setView('tailor') } }, [focusCode])
  const [tailorPlan, setTailorPlan] = useState(null)
  const [tailoring, setTailoring] = useState(false)

  // latex
  const [versions, setVersions] = useState([])
  const [texVersionId, setTexVersionId] = useState('')
  const [tex, setTex] = useState('')
  const [compiling, setCompiling] = useState(false)
  const [pdfRev, setPdfRev] = useState(0)
  const [compileInfo, setCompileInfo] = useState(null)

  // 简历质量检查（P4）
  const [quality, setQuality] = useState(null)
  const [qualityBusy, setQualityBusy] = useState(false)
  const runQuality = () => {
    setQualityBusy(true)
    apiGet('/resume/quality').then(setQuality).catch((err) => setError(err.message)).finally(() => setQualityBusy(false))
  }

  // documents（个人资料库）
  const [docs, setDocs] = useState(null)
  const [docUploading, setDocUploading] = useState(false)

  const loadVault = useCallback(() => {
    apiGet('/experience').then((res) => setVault(res)).catch((err) => setError(err.message))
  }, [])
  const loadVersions = useCallback(() => {
    apiGet('/resumes').then((res) => {
      setVersions(res.resumes ?? [])
      setTexVersionId((prev) => prev || res.active || res.resumes?.[0]?.id || '')
    }).catch((err) => setError(err.message))
  }, [])
  const loadJobs = useCallback(() => {
    apiGet('/jobs?limit=100').then((res) => setJobs(res.jobs ?? [])).catch((err) => setError(err.message))
  }, [])
  const loadDocs = useCallback(() => {
    apiGet('/documents').then(setDocs).catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    if (view === 'vault') loadVault()
    if (view === 'tailor') loadJobs()
    if (view === 'latex') loadVersions()
    if (view === 'docs') loadDocs()
  }, [view, loadVault, loadJobs, loadVersions, loadDocs])

  useEffect(() => {
    if (view !== 'latex' || !texVersionId) return
    apiGet(`/resume/tex?versionId=${encodeURIComponent(texVersionId)}`)
      .then((res) => { setTex(res.tex ?? ''); setCompileInfo(null) })
      .catch((err) => setError(err.message))
  }, [view, texVersionId])

  // ── upload ──
  const onFile = async (event) => {
    const files = Array.from(event?.target?.files ?? []).slice(0, 40)
    if (!files.length) return
    setUploading(true)
    setError(null)
    setNotice(null)
    const done = []
    const failed = []
    const dup = []
    try {
      for (const file of files) {
        try {
          const dataBase64 = await readAsBase64(file)
          const res = await apiPost('/resume/upload', { fileName: file.name, dataBase64, seedVault: false, setActive: false })
          done.push({ name: file.name, chars: res.chars, confidence: res.proposal?.confidence ?? 0, resumeId: res.resumeId })
        } catch (err) {
          const msg = String(err?.message ?? err)
          if (/重复|相同|duplicate/i.test(msg)) dup.push(file.name)
          else failed.push({ name: file.name, error: msg.slice(0, 160) })
        }
      }
      const okText = `已导入 ${done.length} 份` + (done.length ? `（${done.map((d) => `${d.name} ${d.chars}字`).join('、')}）` : '')
      const failText = failed.length ? `；失败 ${failed.length} 份：${failed.map((f) => `${f.name}（${f.error}）`).join('、')}` : ''
      setNotice(okText + failText + '。原始文件都保留，接下来去「素材库」合并去重。')
      onChanged?.()
    } finally {
      setUploading(false)
      if (event?.target) event.target.value = ''
    }
  }

  // ── vault ──
  const saveDraft = () => {
    const bullets = draft.bullets.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!draft.organization.trim() && !draft.role.trim() && !bullets.length) {
      setError('至少填公司/项目名或一条要点')
      return
    }
    apiPost('/experience', {
      kind: draft.kind,
      organization: draft.organization.trim() || undefined,
      role: draft.role.trim() || undefined,
      startAt: draft.startAt || undefined,
      endAt: draft.endAt || undefined,
      bullets,
    }).then(() => {
      setDraft({ kind: draft.kind, organization: '', role: '', startAt: '', endAt: '', bullets: '' })
      setNotice('已加入素材库')
      loadVault()
    }).catch((err) => setError(err.message))
  }

  const patchExperience = (id, patch) => apiPost('/experience/update', { id, ...patch })
    .then(() => { loadVault(); setNotice('已保存') })
    .catch((err) => setError(err.message))

  const removeExperience = (id) => apiPost('/experience/delete', { id })
    .then(() => { loadVault(); setNotice('已删除') })
    .catch((err) => setError(err.message))

  const toggleVerified = (exp) => patchExperience(exp.id, { verified: !exp.verified })

  // ── tailor ──
  const runTailor = (dryRun) => {
    if (!tailorJobId) {
      setError('先选一个目标岗位')
      return
    }
    setTailoring(true)
    setError(null)
    apiPost('/resume/tailor', { jobId: tailorJobId, dryRun })
      .then((res) => {
        setTailorPlan(res)
        if (!dryRun) {
          setNotice(`已生成定制版本「${res.label}」（未自动设为当前版本）`)
          onChanged?.()
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setTailoring(false))
  }

  // ── latex ──
  const saveTex = () => apiPost('/resume/tex', { versionId: texVersionId, tex })
    .then(() => setNotice('LaTeX 源码已保存'))
    .catch((err) => setError(err.message))

  const regenerateTex = () => apiPost('/resume/tex', { versionId: texVersionId, regenerate: true })
    .then((res) => { setTex(res.tex ?? ''); setNotice('已根据解析结果重新生成骨架') })
    .catch((err) => setError(err.message))

  const compile = () => {
    setCompiling(true)
    setError(null)
    apiPost('/resume/compile', { versionId: texVersionId, tex })
      .then((res) => {
        setCompileInfo(res)
        if (res.ok) {
          setPdfRev((n) => n + 1)
          setNotice(`编译成功（${res.engine}${res.cached ? ' · 缓存' : ` · ${res.ms}ms`}）`)
        } else {
          setError(`编译失败：${res.error ?? '未知错误'}`)
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setCompiling(false))
  }

  const downloadTex = () => {
    try {
      const blob = new Blob([tex], { type: 'application/x-tex' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `resume-${texVersionId.slice(0, 8)}.tex`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('下载失败，可直接复制文本框内容')
    }
  }

  const pdfUrl = texVersionId ? `${API}/resume/pdf?id=${encodeURIComponent(texVersionId)}&v=${pdfRev}` : ''

  // ── render helpers ──
  const subnav = h('div', { style: { ...S.row, flexWrap: 'wrap' } },
    [['upload', '上传'], ['vault', '素材库'], ['docs', '资料库'], ['tailor', '针对岗位微调'], ['latex', 'LaTeX 工作室']].map(([key, label]) =>
      h(Btn, { key, kind: view === key ? 'primary' : undefined, onClick: () => { setView(key); setError(null); setNotice(null); setTailorPlan(null) } }, label)))

  const vaultList = !vault
    ? h(Loading)
    : vault.experiences.length === 0
      ? h(Empty, { title: '素材库还是空的', hint: '先「上传」一份简历自动沉淀，或在这里手动加一条实习/项目。' })
      : h('div', { style: S.col }, vault.experiences.map((exp) => h('div', { key: exp.id, style: S.cardTight },
        h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
            h('div', { style: { ...S.body, fontWeight: 600 } },
              `${exp.organization ?? '（未填机构）'}${exp.role ? ` · ${exp.role}` : ''}`),
            h('div', { style: S.mono }, `${(vault.kindLabels ?? {})[exp.kind] ?? exp.kind}${exp.period ? ` · ${exp.period}` : ''}`)),
          h('div', { style: { ...S.row, gap: 6 } },
            h(Chip, { tone: exp.verified ? 'success' : 'warn' }, exp.verified ? '已确认' : '待确认'),
            h(Btn, { kind: 'ghost', onClick: () => toggleVerified(exp) }, exp.verified ? '取消确认' : '确认属实'),
            h(Btn, { kind: 'ghost', onClick: () => removeExperience(exp.id) }, '删除'))),
        exp.bullets.length
          ? h('div', { style: { marginTop: 6 } }, exp.bullets.map((bullet, i) => h('div', { key: i, style: { ...S.muted } }, `· ${bullet}`)))
          : h('div', { style: { ...S.muted, marginTop: 6 } }, '（这条没有要点）'),
        exp.skills.length
          ? h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 4, marginTop: 6 } }, exp.skills.map((s) => h(Chip, { key: s }, s)))
          : null)))

  const tailorPreview = tailorPlan
    ? h('div', { style: S.col },
      h('div', { style: { ...S.cardTight, borderColor: T.accent } },
        h('div', { style: S.h3 }, tailorPlan.dryRun === false ? '已生成的定制版本' : '微调方案（预览）'),
        (tailorPlan.plan?.rationale ?? []).map((line, i) => h('div', { key: i, style: { ...S.muted, marginTop: 3 } }, `· ${line}`)),
        (tailorPlan.plan?.warnings ?? []).map((line, i) => h('div', { key: `w${i}`, style: { ...S.muted, color: T.warn } }, `! ${line}`))),
      h('div', { style: S.grid(320) },
        h('div', { style: S.card },
          h('div', { style: S.h2 }, `保留的经历（${tailorPlan.plan?.selected?.length ?? 0}）`),
          (tailorPlan.plan?.selected ?? []).map((item) => h('div', { key: item.experienceId, style: S.cardTight },
            h('div', { style: { ...S.body, fontWeight: 600 } }, `${item.organization ?? ''}${item.role ? ` · ${item.role}` : ''}`),
            h('div', { style: S.mono }, `${item.kindLabel}${item.period ? ` · ${item.period}` : ''}`),
            item.bullets.map((b, i) => h('div', { key: i, style: { ...S.muted, marginTop: 2 } }, `· ${b}`)),
            item.matchedSkills?.length
              ? h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 4, marginTop: 4 } }, item.matchedSkills.map((s) => h(Chip, { key: s, tone: 'success' }, s)))
              : null))),
        h('div', { style: S.col },
          h('div', { style: S.card },
            h('div', { style: S.h2 }, `移出的经历（${tailorPlan.plan?.omitted?.length ?? 0}）`),
            (tailorPlan.plan?.omitted ?? []).length
              ? tailorPlan.plan.omitted.map((item) => h('div', { key: item.experienceId, style: { ...S.muted, marginTop: 3 } },
                `${item.organization ?? ''} · ${item.role ?? ''} — ${item.reason}`))
              : h('div', { style: S.muted }, '没有移出任何经历。')),
          h('div', { style: S.card },
            h('div', { style: S.h2 }, `岗位要求里你缺的（${tailorPlan.plan?.gaps?.length ?? 0}）`),
            (tailorPlan.plan?.gaps ?? []).length
              ? h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 4 } }, tailorPlan.plan.gaps.map((g) => h(Chip, { key: g, tone: 'error' }, g)))
              : h('div', { style: S.muted }, '没有识别出缺口。'),
            h('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } }, '这些是素材库里确实没有的东西——系统不会替你编。要么补经历，要么承认不匹配。')))),
      tailorPlan.preview
        ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '生成的简历（纯文本预览）'),
          h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit', margin: 0 } }, tailorPlan.preview))
        : null,
      h('div', { style: S.row },
        h(Btn, { kind: 'primary', disabled: tailoring, onClick: () => runTailor(false) }, '生成这个岗位的版本')))
    : null

  const latexView = h('div', { style: S.col },
    // 简历质量检查：只报可核对的问题，不替你补内容
    h('div', { style: S.card },
      h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap' } },
        h('div', { style: S.h2 }, '简历质量检查'),
        h(Btn, { kind: 'primary', onClick: runQuality, disabled: qualityBusy }, qualityBusy ? '检查中…' : '开始检查')),
      h('div', { style: { ...S.muted, marginTop: 4 } },
        '只列出可核对的问题（缺联系方式、教育缺时间、时间倒挂、技能无依据等），不替你补内容、不评判好坏。'),
      quality
        ? h('div', { style: { marginTop: 8 } },
          h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6, marginBottom: 6 } },
            h(Chip, { tone: quality.summary.error ? 'error' : 'success' }, `error ${quality.summary.error}`),
            h(Chip, { tone: quality.summary.warn ? 'warn' : undefined }, `warn ${quality.summary.warn}`),
            h(Chip, null, `info ${quality.summary.info}`)),
          quality.issues.length
            ? h('div', { style: S.col }, quality.issues.map((iss, i) => h('div', {
              key: i,
              style: { ...S.muted, padding: '3px 0', color: iss.level === 'error' ? T.error : iss.level === 'warn' ? T.warn : T.muted },
            }, `${iss.level === 'error' ? '✕' : iss.level === 'warn' ? '!' : '·'} ${iss.message}`)))
            : h('div', { style: { ...S.muted, color: T.success } }, '没有发现可核对的问题。'))
        : null),
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '选择版本'),
      h('div', { style: { ...S.row, flexWrap: 'wrap' } },
        h('select', { style: { ...S.input, maxWidth: 360 }, value: texVersionId, onChange: (e) => setTexVersionId(e.target.value) },
          versions.length
            ? versions.map((v) => h('option', { key: v.id, value: v.id }, `${v.label}${v.is_active ? '（当前）' : ''}`))
            : h('option', { value: '' }, '还没有简历版本')),
        h(Btn, { onClick: regenerateTex, disabled: !texVersionId }, '从解析结果重生成'),
        h(Btn, { onClick: saveTex, disabled: !texVersionId }, '保存源码'),
        h(Btn, { kind: 'primary', onClick: compile, disabled: !texVersionId || compiling }, compiling ? '编译中…' : '编译 PDF'),
        h(Btn, { kind: 'ghost', onClick: downloadTex, disabled: !tex }, '下载 .tex'),
        h(Btn, { kind: 'ghost', onClick: () => window.open('https://www.overleaf.com/project', '_blank') }, '打开 Overleaf')),
      compileInfo && !compileInfo.ok && compileInfo.logTail
        ? h('pre', { style: { ...S.mono, marginTop: 8, maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', color: T.error } }, compileInfo.logTail)
        : null),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10, minHeight: 420 } },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, 'LaTeX 源码'),
        h('textarea', {
          style: { ...S.textarea, minHeight: 380, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, lineHeight: 1.5 },
          value: tex,
          spellCheck: false,
          onChange: (e) => setTex(e.target.value),
        })),
      h('div', { style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.h2 }, 'PDF 预览'),
          compileInfo?.pdfPath ? h(Chip, { tone: 'success' }, compileInfo.engine ?? 'compiled') : null),
        texVersionId && compileInfo?.ok
          ? h('iframe', {
            title: 'resume-pdf',
            src: pdfUrl,
            style: { width: '100%', height: 400, border: `1px solid ${T.border}`, borderRadius: 8, background: '#fff' },
          })
          : h('div', { style: { ...S.muted, marginTop: 20, textAlign: 'center' } },
            '点「编译 PDF」后在这里预览。编译使用本机 XeLaTeX（-no-shell-escape + 超时保护），相同源码复用缓存。'))))

  const body = view === 'upload'
    ? h('div', { style: S.col },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, '上传简历'),
        h('div', { style: { ...S.muted, marginBottom: 10 } },
          '支持 .pdf / .docx / .md / .txt。上传后会：① 提取文本 ② 生成解析候选 ③ 把识别到的经历沉淀进素材库（标为未确认）。原文件保存在本机 data/resumes/。'),
        h('input', {
          type: 'file',
          multiple: true,
          accept: '.pdf,.docx,.md,.txt,.json',
          onChange: onFile,
          style: { ...S.input, padding: 8, cursor: 'pointer' },
        }),
        h('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } }, '可以一次选多份（旧版本、不同方向、零散笔记都行，最多 40 份）。每份都会保存原文，互不覆盖。'),
        uploading ? h('div', { style: { ...S.muted, marginTop: 8 } }, '正在批量上传并解析…') : null),
      h('div', { style: S.card },
        h('div', { style: S.h2 }, '这套东西怎么配合用'),
        h('div', { style: { ...S.body } },
          h('div', null, '1. **素材库**装你所有详细经历（唯一事实来源，写全写细）。'),
          h('div', null, '2. **针对岗位微调**只从素材库挑选+排序，不改写事实，并列出你缺什么。'),
          h('div', null, '3. **LaTeX 工作室**像 Overleaf 一样改源码看 PDF，导出去 Overleaf 也能编译。'))))
    : view === 'vault'
      ? h('div', { style: S.col },
        h('div', { style: S.card },
          h('div', { style: S.h2 }, '加一条经历'),
          h('div', { style: S.grid(160) },
            h(Field, { label: '类型' }, h('select', { style: S.input, value: draft.kind, onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
              KIND_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)))),
            h(Field, { label: '公司/项目/学校' }, h('input', { style: S.input, value: draft.organization, onChange: (e) => setDraft({ ...draft, organization: e.target.value }) })),
            h(Field, { label: '岗位/角色' }, h('input', { style: S.input, value: draft.role, onChange: (e) => setDraft({ ...draft, role: e.target.value }) })),
            h(Field, { label: '开始' }, h('input', { style: S.input, value: draft.startAt, placeholder: '2025-07', onChange: (e) => setDraft({ ...draft, startAt: e.target.value }) })),
            h(Field, { label: '结束' }, h('input', { style: S.input, value: draft.endAt, placeholder: '2025-09', onChange: (e) => setDraft({ ...draft, endAt: e.target.value }) }))),
          h('div', { style: { marginTop: 8 } },
            h(Field, { label: '要点（每行一条，尽量带真实数字）' },
              h('textarea', { style: S.textarea, value: draft.bullets, onChange: (e) => setDraft({ ...draft, bullets: e.target.value }), placeholder: '负责用户调研，产出 2 份需求文档\n用 SQL 完成留存分析，定位 3 个流失点' }))),
          h('div', { style: { marginTop: 8 } }, h(Btn, { kind: 'primary', onClick: saveDraft }, '加入素材库'))),
        vaultList)
      : view === 'tailor'
        ? h('div', { style: S.col },
          h('div', { style: S.card },
            h('div', { style: S.h2 }, '选目标岗位，生成针对性版本'),
            h('div', { style: { ...S.muted, marginBottom: 8 } }, '先在「岗位雷达」里把岗位存进来。微调只做挑选与排序，不会改写或编造内容。'),
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              h('select', {
                style: { ...S.input, maxWidth: 420 },
                value: tailorJobId,
                onChange: (e) => setTailorJobId(e.target.value),
              },
                h('option', { value: '' }, jobs.length ? '选择岗位…' : '库里还没有岗位'),
                jobs.map((j) => h('option', { key: j.id, value: j.id }, `${j.company} · ${j.title}`)),
              ),
              h(Btn, { kind: 'primary', disabled: tailoring || !tailorJobId, onClick: () => runTailor(true) }, tailoring ? '分析中…' : '预览方案'),
            ),
          ),
          tailorPreview,
        )
        : view === 'latex'
          ? latexView
          : docsView

  const onDocFiles = async (event) => {
    const files = Array.from(event?.target?.files ?? []).slice(0, 40)
    if (!files.length) return
    setDocUploading(true)
    setError(null)
    setNotice(null)
    const ok = []
    const failed = []
    try {
      for (const file of files) {
        try {
          const dataBase64 = await readAsBase64(file)
          const res = await apiPost('/document/upload', { fileName: file.name, dataBase64 })
          ok.push(`${file.name}→${(docs?.categories ?? {})[res.proposal?.category] ?? res.proposal?.category ?? '已存入'}`)
        } catch (err) {
          failed.push(`${file.name}（${String(err?.message ?? err).slice(0, 80)}）`)
        }
      }
      setNotice(`已存入 ${ok.length} 份资料${ok.length ? `：${ok.join('、')}` : ''}` + (failed.length ? `；失败：${failed.join('、')}` : '') + '。类别与分数是自动判断的，请核对后点「确认」。')
      loadDocs()
    } finally {
      setDocUploading(false)
      if (event?.target) event.target.value = ''
    }
  }

  const docList = !docs
    ? h(Loading)
    : docs.documents.length === 0
      ? h(Empty, { title: '资料库还是空的', hint: '把学位证、成绩单、四六级/托福成绩、专利证书、获奖证明一起传进来，系统会分类并存档。' })
      : h('div', { style: S.col }, docs.documents.map((doc) => h('div', { key: doc.id, style: S.cardTight },
        h('div', { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
            h('div', { style: { ...S.body, fontWeight: 600 } }, doc.title),
            h('div', { style: S.mono }, [
              (docs.categories ?? {})[doc.category] ?? doc.category,
              doc.score,
              doc.issuer,
              doc.issued_at,
              doc.credential_id,
            ].filter(Boolean).join(' · '))),
          h('div', { style: { ...S.row, gap: 6 } },
            h(Chip, { tone: doc.verified ? 'success' : 'warn' }, doc.verified ? '已确认' : '待确认'),
            h(Btn, {
              kind: 'ghost',
              onClick: () => apiPost('/document/update', { id: doc.id, verified: !doc.verified })
                .then(() => { loadDocs(); setNotice('已更新') })
                .catch((err) => setError(err.message)),
            }, doc.verified ? '取消确认' : '确认属实'),
            h(Btn, {
              kind: 'ghost',
              onClick: () => apiPost('/document/delete', { id: doc.id })
                .then(() => { loadDocs(); setNotice('已删除') })
                .catch((err) => setError(err.message)),
            }, '删除'))))))

  const docsView = h('div', { style: S.col },
    h('div', { style: S.card },
      h('div', { style: S.h2 }, '个人资料库'),
      h('div', { style: { ...S.muted, marginBottom: 10 } },
        '这里放「凭据」：学历学位、成绩单、四六级/托福、专利、获奖、实习证明。经历放「素材库」，凭据放这里——出简历时按岗位各取所需。'),
      h('input', {
        type: 'file',
        multiple: true,
        accept: '.pdf,.docx,.md,.txt,.json,.png,.jpg,.jpeg,.webp',
        onChange: onDocFiles,
        style: { ...S.input, padding: 8, cursor: 'pointer' },
      }),
      h('div', { style: { ...S.muted, marginTop: 6, fontSize: 11 } },
        '可一次传多份（最多 40）。PDF/DOCX 会提取文本并自动判断类别、抽取托福/雅思/四六级/GPA 分数；图片型扫描件只登记文件、不做 OCR，字段需手工补。'),
      docUploading ? h('div', { style: { ...S.muted, marginTop: 8 } }, '正在上传并解析…') : null,
      docs
        ? h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6, marginTop: 10 } },
          h(Chip, null, `共 ${docs.total ?? 0} 条`),
          h(Chip, { tone: (docs.verified ?? 0) > 0 ? 'success' : undefined }, `已确认 ${docs.verified ?? 0}`),
          Object.entries(docs.byCategory ?? {}).map(([cat, n]) => h(Chip, { key: cat }, `${(docs.categories ?? {})[cat] ?? cat} ${n}`)))
        : null),
    docList)

  return h('div', { style: S.col },
    error ? h('div', { style: { ...S.card, borderColor: T.error, ...S.muted, color: T.error } }, error) : null,
    notice ? h('div', { style: { ...S.card, borderColor: T.success, ...S.muted, color: T.success } }, notice) : null,
    h('div', { style: { ...S.row, justifyContent: 'space-between', flexWrap: 'wrap' } },
      h('div', { style: S.h1 }, '简历工作室'),
      subnav),
    body)
}

/**
 * Keeps one broken tab from taking the whole panel down. React error boundaries
 * must be class components. Without this, a single bad property read unmounts the
 * portal and the panel appears to close itself the moment it opens.
 */
class PanelErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    try {
      console.error('[dsh-career] panel render failed', error, info)
    } catch {
      /* console may be unavailable */
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return h('div', { style: { ...S.card, borderColor: T.error } },
      h('div', { style: { ...S.h3, color: T.error } }, '这个页签渲染失败'),
      h('div', { style: { ...S.mono, wordBreak: 'break-word' } }, String(error?.message ?? error)),
      h('div', { style: { ...S.muted, marginTop: 8 } }, '其他页签仍然可用。请把上面这句错误信息发给我，方便定位。'),
      h('div', { style: { marginTop: 10 } }, h(Btn, { onClick: () => this.setState({ error: null }) }, '重试')))
  }
}

function Panel({ onClose }) {
  const [tab, setTab] = useState('overview')
  const [focusCode, setFocusCode] = useState(null)
  const [focusNote, setFocusNote] = useState(null)
  const [version, setVersion] = useState(0)
  const bootstrap = useApi('/bootstrap', [version])
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  // Live channel: agent tool calls and panel navigation from the conversation.
  useEffect(() => {
    let source
    try {
      source = new EventSource(`${API}/events`)
      source.addEventListener('navigate', (event) => {
        try {
          const payload = JSON.parse(event.data)
          const map = {
            overview: 'overview', home: 'overview', plan: 'plan', career: 'plan',
            resume: 'resume', studio: 'studio', knowledge: 'social', industry: 'industry',
            radar: 'radar', quotes: 'radar', company: 'company', social: 'social',
            tracker: 'tracker', applications: 'tracker', interview: 'interview', settings: 'settings',
          }
          const next = map[payload.tab] ?? 'overview'
          setTab(next)
          setFocusCode(payload.code ?? null)
          setFocusNote(payload.note ?? null)
        } catch {
          /* ignore malformed frames */
        }
      })
      for (const kind of ['jobs', 'applications', 'resume', 'profile', 'monitor', 'company', 'social', 'reports', 'sources', 'knowledge']) {
        source.addEventListener(kind, () => bump())
      }
    } catch {
      /* EventSource unavailable: the panel still works with manual refresh */
    }
    return () => {
      try {
        source?.close()
      } catch {
        /* ignore */
      }
    }
  }, [bump])

  const navigate = (next, code = null) => { setTab(next); setFocusCode(code); setFocusNote(code ? '已带入所选岗位，无需重复填写 JD。' : null) }
  const data = bootstrap.data
  const content = () => {
    switch (tab) {
      case 'plan': return h(PlanTab, { onChanged: bump })
      case 'studio': return h(StudioTab, { onChanged: bump, focusCode })
      case 'resume': return h(ResumeTab, { bootstrap: data, onChanged: bump })
      case 'radar': return h(RadarTab, { focusCode, onChanged: bump, onNavigate: navigate })
      case 'tracker': return h(TrackerTab, { bootstrap: data, onChanged: bump, onNavigate: navigate, focusCode })
      case 'company': return h(CompanyTab)
      case 'industry': return h(IndustryTab)
      case 'social': return h(SocialTab, { onNavigate: navigate })
      case 'interview': return h(InterviewTab, { focusCode })
      case 'settings': return h(SettingsTab, { bootstrap: data, onChanged: bump })
      default: return h(OverviewTab, { bootstrap: data, onNavigate: setTab, onRefresh: bump })
    }
  }

  return createPortal(
    h('div', { className: 'careeros-root', style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(15,23,42,0.35)', backdropFilter: 'blur(2px)', display: 'flex' } },
      h(GlobalStyles),
      h('div', {
        style: {
          position: 'absolute', inset: '3vh 3vw', background: T.bg, borderRadius: 14, border: `1px solid ${T.border}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(15,23,42,0.28)',
        },
      },
        h('div', { style: { ...S.row, justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${T.border}`, background: T.surface } },
          h('div', { style: S.row },
            h('span', { style: { fontSize: 16 } }, '🎯'),
            h('div', null,
              h('div', { style: S.h1 }, 'CareerOS'),
              h('div', { style: { ...S.muted, fontSize: 11 } }, `个人求职情报与实习管理系统 · 数据仅存本机 · ${CLIENT_BUILD}`))),
          h('div', { style: S.row },
            bootstrap.loading ? h(Chip, null, '同步中…') : null,
            h(Btn, { kind: 'ghost', onClick: bump }, '刷新'),
            h(Btn, { kind: 'ghost', onClick: onClose }, '关闭'))),
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
          h('nav', { className: 'careeros-nav', style: { width: 176, flex: '0 0 auto', borderRight: `1px solid ${T.border}`, background: T.surface, padding: 10, display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto' } },
            WORKSPACES.map((ws) => h('div', { key: ws.key, style: { marginBottom: 8 } },
              h('div', {
                style: { ...S.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 8px 2px', opacity: 0.75 },
                title: ws.hint,
              }, ws.label),
              ws.tabs.map((key) => {
                const t = TABS.find((item) => item.key === key)
                if (!t) return null
                return h('button', {
                  key: t.key, type: 'button', onClick: () => navigate(t.key),
                  style: {
                    ...S.btn(tab === t.key ? 'primary' : 'ghost'),
                    justifyContent: 'flex-start', display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', marginBottom: 2,
                    border: 'none', background: tab === t.key ? 'rgba(37,99,235,0.12)' : 'transparent',
                    color: tab === t.key ? T.accent : T.text, fontWeight: tab === t.key ? 650 : 500,
                  },
                }, h('span', { style: { opacity: 0.7 } }, t.icon), t.label)
              }))),
            h('div', { style: { marginTop: 'auto', paddingTop: 10, ...S.muted, fontSize: 10.5, lineHeight: 1.5 } },
              '对话里让 Agent 调用 career_* 工具，面板会实时刷新。')),
          h('main', { style: { flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 } },
            focusCode ? h('div',{style:{...S.cardTight,marginBottom:12,...S.row,justifyContent:'space-between',flexWrap:'wrap'}},h('span',{style:S.muted},'当前围绕同一岗位准备材料与面试'),h('div',{style:S.row},h(Btn,{onClick:()=>navigate('radar',focusCode)},'返回岗位'),h(Btn,{kind:'ghost',onClick:()=>{setFocusCode(null);setFocusNote(null)}},'清除岗位上下文'))) : null,
            focusNote ? h('div', { style: { ...S.cardTight, marginBottom: 10, borderColor: T.accent, background: 'rgba(37,99,235,0.06)', ...S.body } }, `Agent：${focusNote}`) : null,
            bootstrap.error
              ? h(ErrorBox, { error: bootstrap.error, onRetry: bump })
              : bootstrap.loading && !data
                ? h(Loading, { label: '正在读取本地数据库…' })
                : h(PanelErrorBoundary, { key: tab }, content()),
          ),
        ),
      ),
    ),
    document.body,
  )
}
