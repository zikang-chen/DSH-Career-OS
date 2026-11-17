// 统一响应外壳（适配层）。
//
// 需求建议所有工具返回 { ok, data, warnings, next_actions, meta }。
// 但直接改 70+ 个老工具的返回结构会破坏现有调用方与测试，风险太高。
// 所以这里做**适配层**：
//   - 新工具（workflow 系列）在保留原有扁平字段的同时，额外带上 data/warnings/next_actions/meta；
//   - 老工具不改，调用方仍按原样读；
//   - 将来可以逐个迁移到 envelope，而不需要一次性大改。
//
// 这是「逐步统一」，不是「假装统一」。

/** 成功外壳。data 为结构性结果，扁平字段由调用方自行决定是否保留。 */
export function envelope(data, { warnings = [], nextActions = [], meta = {} } = {}) {
  return {
    ok: true,
    data,
    warnings: warnings.filter(Boolean),
    next_actions: nextActions.filter(Boolean),
    meta,
  }
}

/** 失败外壳。error 必填，其余可选。 */
export function failure(error, { warnings = [], meta = {} } = {}) {
  return {
    ok: false,
    error: String(error ?? 'unknown error'),
    warnings: warnings.filter(Boolean),
    meta,
  }
}

/**
 * 把 envelope 与扁平字段合并：既保留旧调用方读的扁平字段，又带上统一外壳。
 * 用法：tools 里 `return flat(envelope(data, opts), { ...data })`
 */
export function flat(envelopeResult, flatFields = {}) {
  return { ...envelopeResult, ...flatFields }
}
