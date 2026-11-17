// 投递材料快照：只复制已有数据库事实，不修改简历/资料，不读取或声称保存原附件二进制。
import { createHash } from 'node:crypto'
import { nowIso, parseJson, toBool } from './util.js'

const text = (value) => value === null || value === undefined ? null : String(value)
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  return value
}
export const submissionContentHash = (value) => sha256(JSON.stringify(stable(value)))

function resumeSnapshot(row) {
  if (!row) return null
  const rawText = text(row.raw_text ?? row.rawText)
  const texSource = text(row.tex_source ?? row.texSource)
  const snapshot = {
    id: row.id ?? null,
    label: row.label ?? null,
    targetRole: row.target_role ?? row.targetRole ?? null,
    targetJobId: row.target_job_id ?? row.targetJobId ?? null,
    parentVersionId: row.parent_version_id ?? row.parentVersionId ?? null,
    sourceType: row.source_type ?? row.sourceType ?? null,
    language: row.language ?? null,
    fileName: row.file_name ?? row.fileName ?? null,
    filePath: row.file_path ?? row.filePath ?? null,
    mime: row.mime ?? null,
    rawText,
    texSource,
    parsed: parseJson(row.parsed, null),
    parseStatus: row.parse_status ?? row.parseStatus ?? null,
    parseNotes: row.parse_notes ?? row.parseNotes ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    contentAvailable: Boolean(rawText || texSource),
    rawTextHash: rawText === null ? null : sha256(rawText),
    texSourceHash: texSource === null ? null : sha256(texSource),
  }
  return { ...snapshot, hash: submissionContentHash(snapshot) }
}

function documentSnapshot(row) {
  const rawText = text(row.raw_text ?? row.rawText)
  const snapshot = {
    id: row.id ?? null,
    title: row.title ?? null,
    category: row.category ?? null,
    issuer: row.issuer ?? null,
    issuedAt: row.issued_at ?? row.issuedAt ?? null,
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    credentialId: row.credential_id ?? row.credentialId ?? null,
    score: row.score ?? null,
    scoreValue: row.score_value ?? row.scoreValue ?? null,
    scoreUnit: row.score_unit ?? row.scoreUnit ?? null,
    fileName: row.file_name ?? row.fileName ?? null,
    filePath: row.file_path ?? row.filePath ?? null,
    mime: row.mime ?? null,
    rawText,
    tags: parseJson(row.tags, []),
    verified: toBool(row.verified),
    notes: row.notes ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    rawTextHash: rawText === null ? null : sha256(rawText),
  }
  return { ...snapshot, hash: submissionContentHash(snapshot) }
}

/** 兼容原函数参数与索引字段；state 区分可刷新的草稿和首次正式投递时的不可变证据。 */
export function buildSubmissionSnapshot({ resumeVersion, documents = [], specified = false, note, state = 'draft', capturedAt = nowIso() } = {}) {
  const resume = resumeSnapshot(resumeVersion)
  const docs = documents.map(documentSnapshot)
  const payload = { resume, documents: docs, materialsSpecified: Boolean(specified) }
  // 深拷贝 parsed/tags 等对象，避免调用方随后修改输入时篡改返回的快照。
  return JSON.parse(JSON.stringify({
    version: 2,
    state,
    frozen: state === 'submitted',
    frozenAt: state === 'submitted' ? capturedAt : null,
    resumeVersionId: resume?.id ?? null,
    resumeLabel: resume?.label ?? null,
    resumeTargetJobId: resume?.targetJobId ?? null,
    ...payload,
    capturedAt,
    note: note ?? (specified ? null : '没有指定提交材料，快照诚实留空，不会自动采用当前激活简历。'),
    noteSpecified: note !== undefined && note !== null,
    hashAlgorithm: 'sha256',
    contentScope: 'database-text-and-metadata',
    warnings: resume && !resume.contentAvailable ? ['所选简历没有可冻结的正文或 LaTeX；仅有元数据，不能据此还原原始文件。'] : [],
    hash: submissionContentHash(payload),
  }))
}
