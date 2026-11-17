// 多源简历合并：把「一堆乱七八糟的简历」收敛成一份可信素材库。
//
// 三条硬约束：
//   1. 只合并已有事实，绝不生成新事实——冲突就报冲突，让人来判；
//   2. 合并可逆——每次改动都记录来源，原始简历版本始终保留；
//   3. 相似不等于相同——同一段实习的两种写法要合并，不同项目不能误并。
import { extractSkills } from './domain.js'
import { companyKey, normKey, similarity } from './util.js'

/** 同一条经历的稳定身份：机构 + 角色 + 起止。 */
export function experienceKey(exp) {
  return [companyKey(exp.organization ?? ''), normKey(exp.role ?? ''), normKey(exp.start_at ?? ''), normKey(exp.end_at ?? '')].join('|')
}

/** 宽松身份：只看机构，用于发现「同一家公司写了两段」。 */
export function looseKey(exp) {
  return companyKey(exp.organization ?? '')
}

const BULLET_SIMILAR = 0.86

function bulletText(bullet) {
  return normKey(String(bullet ?? ''))
}

/** 两条要点是否在说同一件事。 */
export function sameBullet(a, b) {
  const na = bulletText(a)
  const nb = bulletText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // 一条是另一条的子串（改写时常有增删修饰）
  if (na.length >= 8 && nb.length >= 8 && (na.includes(nb) || nb.includes(na))) return true
  return similarity(a, b) >= BULLET_SIMILAR
}

/** 要点去重：保留先出现的写法，返回新增项与被合并项。 */
export function dedupeBullets(existing, incoming) {
  const kept = [...existing]
  const added = []
  const merged = []
  for (const bullet of incoming ?? []) {
    if (!String(bullet ?? '').trim()) continue
    const hit = kept.find((item) => sameBullet(item, bullet))
    if (hit) {
      if (normKey(hit) !== normKey(bullet)) merged.push({ existing: hit, incoming: bullet })
      continue
    }
    kept.push(bullet)
    added.push(bullet)
  }
  return { bullets: kept, added, merged }
}

function unionList(a, b) {
  const out = [...(a ?? [])]
  for (const item of b ?? []) {
    const key = normKey(item)
    if (!key) continue
    if (!out.some((existing) => normKey(existing) === key)) out.push(item)
  }
  return out
}

/**
 * 把一条「进料」合并进已有经历。
 * @returns {{patch:object, addedBullets:string[], conflicts:Array}}
 */
export function mergeExperience(existing, incoming) {
  const conflicts = []
  const patch = {}

  const { bullets, added, merged } = dedupeBullets(existing.bullets ?? [], incoming.bullets ?? [])
  if (added.length) patch.bullets = bullets

  const skills = unionList(existing.skills ?? [], [
    ...(incoming.skills ?? []),
    ...extractSkills([incoming.organization, incoming.role, ...(incoming.bullets ?? [])].join(' ')),
  ])
  if (skills.length !== (existing.skills ?? []).length) patch.skills = skills

  const tags = unionList(existing.tags ?? [], incoming.tags ?? [])
  if (tags.length !== (existing.tags ?? []).length) patch.tags = tags

  const links = unionList(existing.links ?? [], incoming.links ?? [])
  if (links.length !== (existing.links ?? []).length) patch.links = links

  for (const field of ['organization', 'role', 'start_at', 'end_at', 'location']) {
    const current = existing[field]
    const next = incoming[field]
    if (!next) continue
    if (!current) {
      patch[field] = next
      continue
    }
    if (normKey(current) !== normKey(next)) {
      conflicts.push({ field, current, incoming: next })
    }
  }

  return { patch, addedBullets: added, mergedBullets: merged, conflicts }
}

/**
 * 全量合并计划：把进料列表规划成 creates / updates / duplicates / conflicts。
 * 幂等：同一批进料重复执行不会重复创建（已存在的会走 updates）。
 *
 * @param {object} input
 * @param {Array} input.existing 素材库现有条目
 * @param {Array} input.incoming 待合并条目（结构同素材库）
 * @param {boolean} [input.allowLoose] 允许按「同一机构」近似合并（默认 false，保守）
 */
export function planMerge({ existing = [], incoming = [], allowLoose = false }) {
  const creates = []
  const updates = []
  const duplicates = []
  const conflicts = []
  const seenKeys = new Map()

  for (const row of existing) seenKeys.set(experienceKey(row), row)

  for (const candidate of incoming) {
    const key = experienceKey(candidate)
    const exact = seenKeys.get(key)
      ?? existing.find((row) => experienceKey(row) === key)
    const target = exact
      ?? (allowLoose && candidate.organization
        ? existing.find((row) => row.kind === candidate.kind && looseKey(row) === looseKey(candidate) && looseKey(candidate))
        : null)

    if (target) {
      // 批内重复：同一批里出现两次相同经历
      if (target.__pending) {
        duplicates.push({ key, ids: [target.__pendingId, candidate.__sourceId].filter(Boolean), reason: '同一批进料内重复' })
        continue
      }
      const merged = mergeExperience(target, candidate)
      const meaningful = Object.keys(merged.patch).length > 0 || merged.addedBullets.length > 0
      if (meaningful) {
        updates.push({
          id: target.id,
          key,
          patch: merged.patch,
          addedBullets: merged.addedBullets,
          mergedBullets: merged.mergedBullets,
          from: candidate.__sourceLabel ?? null,
        })
      }
      for (const conflict of merged.conflicts) {
        conflicts.push({ id: target.id, key, ...conflict })
      }
      continue
    }

    const created = { ...candidate }
    delete created.__pending
    creates.push({ key, incoming: created, from: candidate.__sourceLabel ?? null })
    const pending = { ...candidate, __pending: true, __pendingId: candidate.__sourceId ?? key }
    seenKeys.set(key, pending)
    existing = [...existing, pending]
  }

  return {
    creates,
    updates,
    duplicates,
    conflicts,
    summary: {
      incoming: incoming.length,
      create: creates.length,
      update: updates.length,
      duplicate: duplicates.length,
      conflict: conflicts.length,
      addedBullets: updates.reduce((sum, u) => sum + u.addedBullets.length, 0),
    },
    note: '只做合并与去重，不生成新事实。冲突项需要人工确认保留哪个版本。',
  }
}

/** 全库健康检查：同一机构多段、空要点、未确认等。 */
export function auditVault(experiences = []) {
  const byLoose = new Map()
  for (const exp of experiences) {
    const key = looseKey(exp)
    if (!key) continue
    if (!byLoose.has(key)) byLoose.set(key, [])
    byLoose.get(key).push(exp)
  }
  const likelyDuplicates = [...byLoose.entries()]
    .filter(([, rows]) => rows.length > 1 && !rows.every((row) => row.kind === rows[0].kind) === false)
    .map(([key, rows]) => ({ key, ids: rows.map((row) => row.id), organization: rows[0].organization, count: rows.length }))
  const emptyBullets = experiences.filter((exp) => !(exp.bullets ?? []).length).map((exp) => exp.id)
  const unverified = experiences.filter((exp) => exp.verified === false).length
  return {
    total: experiences.length,
    likelyDuplicates,
    emptyBullets,
    unverified,
    note: 'likelyDuplicates 只按机构粗判，是否真重复要看 role/period；空要点的条目对定制简历没有价值。',
  }
}
