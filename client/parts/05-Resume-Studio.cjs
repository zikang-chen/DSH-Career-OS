// ─── Resume Studio ───────────────────────────────────────────────────────────
function ResumeTab({ bootstrap, onChanged }) {
  const backend = useBackend()
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [proposal, setProposal] = useState(null)
  const [compare, setCompare] = useState(null)
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [profileForm, setProfileForm] = useState(null)

  useEffect(() => {
    if (bootstrap && !profileForm) {
      const p = bootstrap.profile
      setProfileForm({
        displayName: p.display_name ?? '', headline: p.headline ?? '', school: p.school ?? '', degree: p.degree ?? '',
        major: p.major ?? '', gradYear: p.grad_year ?? '', availabilityStart: p.availability_start ?? '',
        weeklyDays: p.weekly_days ?? '', cities: (p.cities ?? []).join('，'),
        targetIndustries: (p.target_industries ?? []).join('，'), targetRoles: (p.target_roles ?? []).join('，'),
        targetCompanies: (p.target_companies ?? []).join('，'), excluded: (p.excluded ?? []).join('，'),
      })
    }
  }, [bootstrap, profileForm])

  const resumes = bootstrap?.resumes ?? []

  const doImport = async () => {
    if (!path.trim() && !text.trim()) return backend.setError('请填写文件路径或粘贴简历文本')
    await backend.call(() => apiPost('/resume/import', { path: path.trim() || undefined, text: text.trim() || undefined, label: label.trim() || undefined }))
      .then((res) => {
        setProposal(res)
        onChanged()
      })
      .catch(() => {})
  }

  const saveProfile = async () => {
    const payload = {
      displayName: profileForm.displayName, headline: profileForm.headline, school: profileForm.school,
      degree: profileForm.degree, major: profileForm.major,
      gradYear: profileForm.gradYear === '' ? null : Number(profileForm.gradYear),
      availabilityStart: profileForm.availabilityStart,
      weeklyDays: profileForm.weeklyDays === '' ? null : Number(profileForm.weeklyDays),
      cities: profileForm.cities, targetIndustries: profileForm.targetIndustries,
      targetRoles: profileForm.targetRoles, targetCompanies: profileForm.targetCompanies,
      excluded: profileForm.excluded,
    }
    await backend.call(() => apiPost('/profile', payload)).then(() => onChanged()).catch(() => {})
  }

  const set = (key) => (ev) => setProfileForm((prev) => ({ ...prev, [key]: ev.target.value }))

  return h('div', { style: S.col },
    backend.error ? h(ErrorBox, { error: backend.error, onRetry: () => backend.setError(null) }) : null,

    h('div', { style: S.grid(340) },
      h('div', { style: S.card },
        h('div', { style: S.h2 }, '导入简历'),
        h('div', { style: { ...S.muted, marginBottom: 8 } }, '支持 .md / .txt / .docx / .pdf。解析结果只是「候选」，确认后才会写入画像。'),
        h('div', { style: S.col, gap: 8 },
          h(Field, { label: '文件绝对路径', hint: '例如 D:\\career_os\\resume.pdf（由 Host 本机读取）' },
            h('input', { style: S.input, value: path, onChange: (e) => setPath(e.target.value), placeholder: 'D:\\...\\简历.docx' })),
          h(Field, { label: '或直接粘贴简历全文', hint: 'PDF 是扫描件或 CID 字体时用这个' },
            h('textarea', { style: { ...S.textarea, minHeight: 110 }, value: text, onChange: (e) => setText(e.target.value), placeholder: '在这里粘贴简历文本…' })),
          h(Field, { label: '版本标签（可选）' }, h('input', { style: S.input, value: label, onChange: (e) => setLabel(e.target.value), placeholder: '产品方向-v1' })),
          h(Btn, { kind: 'primary', disabled: backend.busy, onClick: doImport }, backend.busy ? '解析中…' : '导入并解析'))),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '简历版本'),
        resumes.length
          ? h('div', { style: S.col }, resumes.map((r) => h('div', { key: r.id, style: { ...S.cardTight, ...S.row, justifyContent: 'space-between' } },
            h('div', { style: { ...S.col, gap: 2, minWidth: 0 } },
              h('div', { style: { ...S.body, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' } },
                r.label, r.is_active ? h(Chip, { tone: 'success' }, '当前') : null),
              h('div', { style: S.mono }, `${r.parse_status} · ${r.text_length ?? 0} 字符 · ${fmtDate(r.created_at)}`)),
            h('div', { style: S.row },
              r.is_active ? null : h(Btn, { kind: 'ghost', onClick: () => backend.call(() => apiPost('/resume/activate', { id: r.id })).then(() => onChanged()).catch(() => {}) }, '设为当前'),
              h(Btn, { kind: 'ghost', onClick: () => { setAId(bId || r.id); setBId(r.id) } }, '对比')))))
          : h(Empty, { title: '还没有简历', hint: '导入一份简历后，系统才能做岗位匹配与缺口分析。' }),

        resumes.length >= 2
          ? h('div', { style: { ...S.cardTight, marginTop: 10 } },
            h('div', { style: S.h3 }, '版本对比'),
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              h('select', { style: { ...S.input, width: 130 }, value: aId, onChange: (e) => setAId(e.target.value) },
                h('option', { value: '' }, 'A 版本'),
                resumes.map((r) => h('option', { key: r.id, value: r.id }, r.label))),
              h('select', { style: { ...S.input, width: 130 }, value: bId, onChange: (e) => setBId(e.target.value) },
                h('option', { value: '' }, 'B 版本'),
                resumes.map((r) => h('option', { key: r.id, value: r.id }, r.label))),
              h(Btn, { onClick: () => aId && bId && backend.call(() => apiPost('/resume/compare', { aId, bId })).then(setCompare).catch(() => {}) }, '比较')),
            compare ? h('div', { style: { marginTop: 8, ...S.col, gap: 4 } },
              h('div', { style: { ...S.muted, color: T.success } }, `新增 ${compare.added.length} 行`),
              compare.added.slice(0, 6).map((line, i) => h('div', { key: `a${i}`, style: { ...S.mono, color: T.success } }, `+ ${line.slice(0, 90)}`)),
              h('div', { style: { ...S.muted, color: T.error, marginTop: 6 } }, `删除 ${compare.removed.length} 行`),
              compare.removed.slice(0, 6).map((line, i) => h('div', { key: `r${i}`, style: { ...S.mono, color: T.error } }, `- ${line.slice(0, 90)}`))) : null)
          : null),

      h('div', { style: S.card },
        h('div', { style: S.h2 }, '个人画像'),
        h('div', { style: { ...S.muted, marginBottom: 8 } }, '留空即「未知」，系统不会替你补全；所有数据只存在本机。'),
        profileForm ? h('div', { style: S.grid(150) },
          h(Field, { label: '姓名' }, h('input', { style: S.input, value: profileForm.displayName, onChange: set('displayName') })),
          h(Field, { label: '一句话定位' }, h('input', { style: S.input, value: profileForm.headline, onChange: set('headline') })),
          h(Field, { label: '学校' }, h('input', { style: S.input, value: profileForm.school, onChange: set('school') })),
          h(Field, { label: '学历' }, h('input', { style: S.input, value: profileForm.degree, onChange: set('degree') })),
          h(Field, { label: '专业' }, h('input', { style: S.input, value: profileForm.major, onChange: set('major') })),
          h(Field, { label: '毕业年份' }, h('input', { style: S.input, value: profileForm.gradYear, onChange: set('gradYear'), placeholder: '2027' })),
          h(Field, { label: '可实习开始' }, h('input', { style: S.input, type: 'date', value: profileForm.availabilityStart, onChange: set('availabilityStart') })),
          h(Field, { label: '每周出勤天数' }, h('input', { style: S.input, value: profileForm.weeklyDays, onChange: set('weeklyDays'), placeholder: '4' })),
          h(Field, { label: '目标城市（逗号分隔）' }, h('input', { style: S.input, value: profileForm.cities, onChange: set('cities'), placeholder: '北京，上海' })),
          h(Field, { label: '目标行业' }, h('input', { style: S.input, value: profileForm.targetIndustries, onChange: set('targetIndustries') })),
          h(Field, { label: '目标岗位' }, h('input', { style: S.input, value: profileForm.targetRoles, onChange: set('targetRoles') })),
          h(Field, { label: '目标企业' }, h('input', { style: S.input, value: profileForm.targetCompanies, onChange: set('targetCompanies') })),
          h(Field, { label: '排除条件' }, h('input', { style: S.input, value: profileForm.excluded, onChange: set('excluded'), placeholder: '销售，单休' })))
          : h(Loading),
        h('div', { style: { marginTop: 10 } }, h(Btn, { kind: 'primary', disabled: backend.busy, onClick: saveProfile }, '保存画像')),

        (bootstrap?.skills ?? []).length
          ? h('div', { style: { marginTop: 12 } },
            h('div', { style: S.h3 }, `技能矩阵（${bootstrap.skills.length}）`),
            h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 6 } },
              bootstrap.skills.map((s) => h(Chip, { key: s.id, tone: s.verified ? 'success' : undefined }, `${s.name}${s.verified ? ' ✓' : ''}`))))
          : null)),

      proposal
        ? h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('div', { style: S.h2 }, '解析结果（需要你确认）'),
            h(Chip, { tone: proposal.proposal.confidence >= 0.5 ? 'accent' : 'warn' }, `识别率 ${Math.round((proposal.proposal.confidence ?? 0) * 100)}%`)),
          h('div', { style: { ...S.muted, marginBottom: 8 } }, proposal.proposal.caveat),
          h('div', { style: S.grid(200) },
            h('div', { style: S.cardTight }, h('div', { style: S.h3 }, '教育'), proposal.proposal.education.length
              ? proposal.proposal.education.map((e, i) => h('div', { key: i, style: S.body }, [e.school, e.degree, e.major, e.gradYear].filter(Boolean).join(' · ')))
              : h('div', { style: S.muted }, '未识别')),
            h('div', { style: S.cardTight }, h('div', { style: S.h3 }, `技能（${proposal.proposal.skills.length}）`),
              h('div', { style: { ...S.row, flexWrap: 'wrap', gap: 4 } }, proposal.proposal.skills.map((s) => h(Chip, { key: s }, s)))),
            h('div', { style: S.cardTight }, h('div', { style: S.h3 }, `实习经历（${proposal.proposal.experience.length}）`),
              proposal.proposal.experience.length
                ? proposal.proposal.experience.map((e, i) => h('div', { key: i, style: { ...S.muted, marginBottom: 4 } }, `${e.organization ?? '机构未识别'} · ${e.role}`))
                : h('div', { style: S.muted }, '未识别到实习段落')),
            h('div', { style: S.cardTight }, h('div', { style: S.h3 }, '解析提醒'), proposal.proposal.notes.length
              ? proposal.proposal.notes.map((n, i) => h('div', { key: i, style: { ...S.muted, marginBottom: 3 } }, `· ${n}`))
              : h('div', { style: S.muted }, '无'))),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h(Btn, {
              kind: 'primary',
              onClick: () => backend.call(() => apiPost('/profile', proposal.suggestedProfilePatch)).then(() => { setProposal(null); onChanged() }).catch(() => {}),
            }, '把解析结果写入画像'),
            h(Btn, { kind: 'ghost', onClick: () => setProposal(null) }, '稍后再说')))
        : null)
}
