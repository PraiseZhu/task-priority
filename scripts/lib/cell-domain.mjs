// lib/cell-domain.mjs — coverage cell 的 schema/域判据（仅 manifest-validate 调用）
//
// 判据所有权（计划核心机制 C）：schema 形状 / 枚举 / cell 唯一性 / 引用完整性 → manifest-validate 独占
// （经本模块执行）。**不判**：矩阵全覆盖（缺格）、单任务全 n_a、reason_code/evidence 必填、
// B 维度 ui_prediction 现跑比对、n_a_predicted 域限——这些是 coverage-matrix 独占判据，
// 因此 schema 里 reason_code/evidence/ui_prediction 刻意留作可选（所有权单一，防双头）。
//
// 枚举一律从 authority 取（A.FACES / A.GATES / A.HARDENING_CLASSES），本模块零硬编码枚举值。

const CELL_KINDS = ['face', 'gate', 'hardening'];
const CELL_STATUSES = ['covered', 'n_a', 'n_a_predicted'];
const CELL_KEYS = [
  'task_id', 'dimension_kind', 'dimension_id', 'status', 'sc_ids',
  'reason_code', 'evidence', 'ui_prediction', // 三个刻意可选（coverage-matrix 独占必填）
];

/**
 * 校验 coverage 数组（cell 域 / 唯一性 / 引用完整性）。
 * @param {object} arg
 * @param {unknown} arg.coverage manifest 的 coverage 字段
 * @param {Array}   arg.scs      顶层 scs（须已完成 id 唯一性校验）
 * @param {Array}   arg.priorities
 * @param {object}  arg.authority 契约：FACES[] / GATES[] / HARDENING_CLASSES[]（数字或字符串）
 * @returns {Array<{error_code:string, path:string, message:string}>}
 */
export function validateCoverageCells({ coverage, scs, priorities, authority }) {
  const violations = [];
  const priorityIds = new Set(priorities.map((p) => p && p.id));
  const scById = new Map(scs.map((s) => [s && s.id, s]));
  const seenCells = new Set();

  // dimension_id 的枚举源（kind → 权威值数组，统一按字符串比较）
  const dimEnum = {
    face: (authority.FACES || []).map(String),
    gate: (authority.GATES || []).map(String),
    hardening: (authority.HARDENING_CLASSES || []).map(String),
  };

  coverage.forEach((cell, i) => {
    const at = (field) => `coverage[${i}]${field ? '.' + field : ''}`;

    if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
      violations.push({ error_code: 'FIELD_TYPE_INVALID', path: at(''), message: 'cell 必须是对象' });
      return;
    }

    // 未列键 → 拒（exact 契约，F33）
    for (const key of Object.keys(cell)) {
      if (!CELL_KEYS.includes(key)) {
        violations.push({ error_code: 'UNKNOWN_FIELD', path: at(key), message: `coverage cell 未列键 "${key}"（出现即拒）` });
      }
    }

    // task_id ∈ priorities[].id（引用完整性）
    if (typeof cell.task_id !== 'string' || !priorityIds.has(cell.task_id)) {
      violations.push({
        error_code: 'CELL_TASK_UNKNOWN',
        path: at('task_id'),
        message: `task_id "${cell.task_id}" 不在 priorities[].id 中`,
      });
    }

    // dimension_kind 枚举
    if (!CELL_KINDS.includes(cell.dimension_kind)) {
      violations.push({ error_code: 'CELL_KIND_INVALID', path: at('dimension_kind'), message: `dimension_kind "${cell.dimension_kind}" 不在 {face, gate, hardening}` });
    }

    // dimension_id ∈ 对应枚举源（authority 动态；未知 → 拒）
    const kindValid = CELL_KINDS.includes(cell.dimension_kind);
    if (kindValid) {
      const ok = dimEnum[cell.dimension_kind].some((v) => v === String(cell.dimension_id));
      if (!ok) {
        violations.push({
          error_code: 'UNKNOWN_DIMENSION_ID',
          path: at('dimension_id'),
          message: `dimension_id "${cell.dimension_id}" 不在 dimension_kind=${cell.dimension_kind} 的权威枚举中`,
        });
      }
    }

    // status 枚举（n_a_predicted 域限归 coverage-matrix）
    if (!CELL_STATUSES.includes(cell.status)) {
      violations.push({ error_code: 'STATUS_INVALID', path: at('status'), message: `status "${cell.status}" 不在 {covered, n_a, n_a_predicted}` });
    }

    // sc_ids 存在且为数组（所有 status）
    if (!Array.isArray(cell.sc_ids)) {
      violations.push({ error_code: 'FIELD_TYPE_INVALID', path: at('sc_ids'), message: 'sc_ids 必须是数组' });
    } else {
      // 引用完整性：covered 时非空、每个 id 真实存在、且属于同一 task
      if (cell.status === 'covered' && cell.sc_ids.length === 0) {
        violations.push({ error_code: 'CELL_SC_EMPTY', path: at('sc_ids'), message: 'status=covered 的 cell 必须引用至少一个 SC' });
      }
      cell.sc_ids.forEach((scId, j) => {
        const sAt = at(`sc_ids[${j}]`);
        const sc = scById.get(scId);
        if (!sc) {
          violations.push({ error_code: 'CELL_SC_UNKNOWN', path: sAt, message: `引用的 sc_id "${scId}" 在顶层 scs 中不存在` });
        } else if (cell.status === 'covered' && sc.priority_id !== cell.task_id) {
          violations.push({
            error_code: 'CELL_SC_CROSS_TASK',
            path: sAt,
            message: `sc_id "${scId}" 属于 task "${sc.priority_id}"，被 task "${cell.task_id}" 的 covered cell 引用（跨任务）`,
          });
        }
      });
    }

    // cell 唯一性：同 (task_id, dimension_kind, dimension_id) 重复 → 拒
    if (typeof cell.task_id === 'string' && kindValid) {
      const key = `${cell.task_id}|${cell.dimension_kind}|${String(cell.dimension_id)}`;
      if (seenCells.has(key)) {
        violations.push({
          error_code: 'CELL_DUPLICATE',
          path: at(''),
          message: `cell (task_id=${cell.task_id}, dimension_kind=${cell.dimension_kind}, dimension_id=${cell.dimension_id}) 重复`,
        });
      }
      seenCells.add(key);
    }
  });

  return violations;
}
