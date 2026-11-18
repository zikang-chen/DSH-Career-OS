// Cascade deletion for knowledge entries. Files are only unlinked inside the plugin data dir.
import fs from 'node:fs'
import path from 'node:path'

const insideDataDir = (filePath, dataDir) => {
  if (!filePath || !dataDir) return false
  try {
    const root = path.resolve(dataDir)
    const target = path.resolve(filePath)
    return target === root || target.startsWith(root + path.sep)
  } catch { return false }
}

export function mediaFilesOf(item, dataDir) {
  const entries = Array.isArray(item?.media) ? item.media : []
  const files = [], outside = []
  for (const entry of entries) {
    const filePath = typeof entry === 'string' ? null : entry?.filePath
    if (!filePath) continue
    if (insideDataDir(filePath, dataDir)) files.push(path.resolve(filePath))
    else outside.push(String(filePath))
  }
  return { files: [...new Set(files)], outside }
}

/** Deletes the entry, and optionally its source entity + downloaded image files. Audited either way. */
export function deleteKnowledgeCascade({ repos, config }, { id, reason, deleteSource = false, deleteMedia = false } = {}) {
  const item = repos.knowledge.get(String(id))
  if (!item) return { ok: false, error: '资料不存在或已删除' }
  const media = mediaFilesOf(item, config?.dataDir)
  const sourceType = item.sourceEntityType ?? null
  const sourceId = item.sourceEntityId ?? null
  const report = { source: null, media: { deleted: [], failed: [], kept: media.outside.slice(0, 20), note: null } }

  if (deleteSource && sourceType && sourceId) {
    try {
      if (sourceType === 'job') {
        repos.jobs.deleteJob(sourceId)
        report.source = { type: 'job', id: sourceId, deleted: true, note: '岗位及其来源/状态历史/匹配已删除；已存在的投递记录保留但解除岗位绑定。' }
      } else if (sourceType === 'forum_post') {
        const removedPost = repos.intel.deletePost(sourceId, { withClaims: true })
        report.source = { type: 'forum_post', id: sourceId, deleted: Boolean(removedPost?.removed), claimsRemoved: removedPost?.claimsRemoved ?? 0, note: '面经原文记录与其结构化观点已删除。' }
      } else {
        report.source = { type: sourceType, id: sourceId, deleted: false, note: `未知来源类型 ${sourceType}，未删除来源记录` }
      }
    } catch (err) {
      report.source = { type: sourceType, id: sourceId, deleted: false, error: String(err?.message ?? err) }
    }
  } else if (sourceType) {
    report.source = { type: sourceType, id: sourceId, deleted: false, note: '按你的选择保留来源记录' }
  }

  const removal = typeof repos.knowledge.removeMany === 'function' && Array.isArray(id)
    ? repos.knowledge.removeMany(id, { reason })
    : repos.knowledge.remove(String(id), { reason })
  if (!removal?.ok) return { ...removal, ...report }

  if (deleteMedia) {
    for (const file of media.files) {
      try { fs.unlinkSync(file); report.media.deleted.push(file) }
      catch (err) { if (err?.code === 'ENOENT') report.media.deleted.push(file); else report.media.failed.push({ file, error: String(err?.message ?? err) }) }
    }
    report.media.note = media.files.length
      ? `已删除 ${report.media.deleted.length} 个本机图片文件${report.media.failed.length ? `，${report.media.failed.length} 个失败` : ''}。`
      : '这条资料没有本机已下载图片文件。'
  } else {
    report.media.note = media.files.length ? `保留 ${media.files.length} 个本机图片文件（未勾选删除）。` : '没有本机已下载图片文件。'
  }
  if (media.outside.length) report.media.note += ` 另有 ${media.outside.length} 个路径不在插件数据目录内，未处理。`

  return {
    ok: true,
    removed: removal.removed ?? { id: String(id), title: item.title },
    ...report,
    note: '知识库条目已删除，删除记录已留审计。',
  }
}
