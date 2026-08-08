// lib/hashing.mjs — core/plan hash 的**排除键单一实现**（计划核心机制 B / F15 / F25）。
//
// 语义：
//   - CORE_EXCLUDE_KEYS 是**黑名单，递归剔除**：`manifest_core_hash`、`receipts`，
//     以及 `dispatch.packets[].manifest_core_hash`（同名键规则天然覆盖）。
//     除这三处外 manifest 全部字段都进 hash（**含 schema_version 与 slug**）——
//     刻意用黑名单而非白名单：新增字段自动纳入、不漏算。
//   - 剔除后做确定性规范化（键排序递归）再 sha256。回填 `manifest_core_hash`
//     后重算必须得到同值（构造上的不动点，无环）。
//   - planHash 覆盖 priority-plan.md 正文，排除尾部 receipts 区块（由
//     PLAN_RECEIPTS_MARKER 界定：marker 出现处即 receipts 区块起点，截断到其前）。
//
// 本文件是排除键的唯一实现——各脚本禁止各自剔除。
import { createHash } from 'node:crypto';

/** 黑名单排除键（冻结数组，禁止在别处另写一份剔除逻辑） */
export const CORE_EXCLUDE_KEYS = Object.freeze(['manifest_core_hash', 'receipts']);

const EXCLUDE_SET = new Set(CORE_EXCLUDE_KEYS);

/** planHash 的 receipts 区块界定 marker（出现在 priority-plan.md 尾部 receipts 之前） */
export const PLAN_RECEIPTS_MARKER = '<!-- task-priority:receipts:start -->';

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 递归剔除黑名单键 + 键排序规范化。对象键按字典序排序（确定性），
 * 数组保序，标量原样。返回纯数据副本，不改入参。
 */
function stripExcluded(value) {
  if (Array.isArray(value)) return value.map(stripExcluded);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (EXCLUDE_SET.has(key)) continue; // 黑名单：任何层级的同名键都剔除
      out[key] = stripExcluded(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * manifest core hash：manifest 全部字段（含 schema_version/slug）剔除黑名单键后
 * 确定性规范化再 sha256。回填顶层或 packet 的 manifest_core_hash 不影响结果（不动点）。
 */
export function manifestCoreHash(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifestCoreHash: manifest 必须是非数组对象');
  }
  return sha256hex(JSON.stringify(stripExcluded(manifest)));
}

/**
 * plan hash：priority-plan.md 正文，排除尾部 receipts 区块。
 * 正文不含 marker → 全文都算（receipts 区块以 marker 开始，无 marker 即无区块）。
 */
export function planHash(planMarkdownText) {
  if (typeof planMarkdownText !== 'string') {
    throw new Error('planHash: 输入必须是字符串');
  }
  const idx = planMarkdownText.indexOf(PLAN_RECEIPTS_MARKER);
  const body = idx === -1 ? planMarkdownText : planMarkdownText.slice(0, idx);
  return sha256hex(body);
}

/**
 * 草稿祖先 hash（P1-B 谱系机制）：把**当前 manifest** 还原成 Phase 4 对抗质询时的草稿形状
 * （剔除 final 专属键：顶层 waves/dispatch/manifest_core_hash/receipts + 每个 sc 的 preflight）
 * 再算 core hash。这就是「谱系」——Phase 4 质询时的草稿 == 当前 manifest 的草稿祖先；若质询后
 * SC/coverage/priorities 等草稿期字段有变更，祖先 hash 随之漂移 ⇒ review-receipt 的
 * draft_manifest_core_hash 对不上 ⇒ REVIEW_RECEIPT_STALE 拒（补 SC 后必须重新质询并更新 receipt）。
 *
 * 与 CORE_EXCLUDE_KEYS 的关系：manifest_core_hash/receipts 本就在黑名单里（任何层级都剔除），
 * 这里再显式删是**白名单式声明「final 专属」**——waves/dispatch/preflight 只有顶层/SC 级
 * 语义，不做递归剔除。本函数是 final 专属键的唯一实现（禁止在别处另写一份剥离逻辑）。
 */
const FINAL_ONLY_KEYS = Object.freeze(['waves', 'dispatch', 'manifest_core_hash', 'receipts']);

export function draftAncestorHash(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('draftAncestorHash: manifest 必须是非数组对象');
  }
  const ancestor = { ...manifest };
  for (const k of FINAL_ONLY_KEYS) delete ancestor[k];
  if (Array.isArray(ancestor.scs)) {
    ancestor.scs = ancestor.scs.map((s) => {
      if (s === null || typeof s !== 'object') return s;
      const { preflight, ...rest } = s;
      return rest;
    });
  }
  return manifestCoreHash(ancestor);
}
