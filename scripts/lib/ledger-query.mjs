#!/usr/bin/env node
// ledger-query.mjs — task-priority skill 自进化台账的**确定性查询入口**（Phase 1 / Phase 4 消费侧）。
//
// 定位：evolution-note.mjs 是台账唯一**读写**通道（写侧）；本模块是唯一**查询**入口（读侧），
// 把 ledger 变成 Phase 4 对抗质询可直接消费的弹药。**只读：绝不写盘、绝不碰 git、零时间戳**
// （无 --sync 概念、无任何当前时间字段——同一输入永远同一输出）。
//
// 审核席定下的契约（2026-08-09，P2「自进化台账只有写入、无消费闭环」修复）：
//   - 确定性：同一 ledger 输入 → 输出逐字节相同。排序不靠 Object.keys 默认序、不靠插入序：
//     top-occurrences 按复发频次降序、同频按 fingerprint 升序；ledger fingerprint 基于
//     递归规范化 JSON（对象键排序 + 数组元素按规范化串排序），**顺序无关**。
//   - 空台账语义：entries=0（或 ledger 文件尚不存在）→ status=**BOOTSTRAP_EMPTY_LEDGER**，
//     **不是**静默空数组——空数组会被误读成「已查过，无逃逸」，BOOTSTRAP 表示「还没开始
//     积累」。两个语义不可混：Phase 4 看到 BOOTSTRAP 不得据此声明无逃逸。
//   - 损坏台账 fail-closed：JSON 解析失败 / entries 非数组 → exit 2。写侧 evolution-note
//     对损坏按空起步（宽容），读侧不沿用——消费侧静默吞错会让「有数据但已损坏」被当成
//     「无数据」。
//   - 顶层 fingerprint（`ledger-` + sha256 前 10 hex）：绑定本次消费的台账快照。Phase 4
//     质询包必须携带该值，防「下一轮不读/漏传」悄悄发生。
//
// 用法（真实命令形态，SKILL.md Phase 1 / 自进化台账段引用同一形态）：
//   node <SKILL_ROOT>/scripts/lib/ledger-query.mjs
//   # 测试/隔离：TASK_PRIORITY_SKILL_ROOT=<临时根> 重定向台账根（与 evolution-note 同一变量，
//   # 不新增任何 --ledger* 参数——凭空造参数曾污染过真实生产台账）
//
// 唯一实现：查询逻辑只在本文件；evolution-note / gap-backfill / SKILL.md 一律引用本入口，
// 不另写第二份。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_ROOT = process.env.TASK_PRIORITY_SKILL_ROOT
  ? resolve(process.env.TASK_PRIORITY_SKILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEDGER_FILE = join(SKILL_ROOT, 'evolution', 'ledger.json');

const BOOTSTRAP_STATUS = 'BOOTSTRAP_EMPTY_LEDGER';
const OK_STATUS = 'OK';

/**
 * 递归规范化 JSON：对象键排序；数组元素按规范化串排序。
 * 使同内容 ledger 无论字段序/条目序如何，都产出同一个字节序列（顺序无关的确定性哈希基）。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** ledger 快照指纹：`ledger-` + sha256(规范化 JSON) 前 10 hex（顺序无关，同内容恒同值）。 */
export function ledgerFingerprint(ledger) {
  return `ledger-${createHash('sha256').update(canonicalJson(ledger), 'utf8').digest('hex').slice(0, 10)}`;
}

/** 复发频次规范化：非有限数按 0 处理（排序仍确定，不产生 NaN 比较）。 */
function occurrenceOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 确定性查询（纯函数）：ledger 对象 → Phase 4 可直接消费的弹药。
 * entries 非数组 → throw（调用方决定 fail-closed 出口；CLI 一律 exit 2）。
 */
export function queryLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.entries)) {
    throw new Error(
      `ledger 结构非法：entries 必须是数组（收到 ${ledger == null ? String(ledger) : JSON.stringify(ledger).slice(0, 80)}）`,
    );
  }
  const topOccurrences = ledger.entries
    .slice()
    .sort(
      (a, b) =>
        occurrenceOf(b.occurrences) - occurrenceOf(a.occurrences) ||
        String(a.fingerprint).localeCompare(String(b.fingerprint)),
    )
    .map((e) => ({
      fingerprint: e.fingerprint,
      occurrences: occurrenceOf(e.occurrences),
      tier: e.tier ?? null,
      status: e.status ?? null,
      title: e.title ?? null,
      last_seen: e.lastSeen ?? null,
    }));

  const result = {
    status: topOccurrences.length === 0 ? BOOTSTRAP_STATUS : OK_STATUS,
    entries: topOccurrences.length,
    fingerprint: ledgerFingerprint(ledger),
    top_occurrences: topOccurrences,
  };
  if (topOccurrences.length === 0) {
    result.note =
      '台账尚未开始积累（entries=0）——与「已查过、无逃逸」语义不同，Phase 4 不得据此声明无逃逸';
  }
  return result;
}

function fail(message) {
  console.error(`ledger-query FAIL: ${message}`);
  process.exit(2);
}

function main() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 台账文件尚不存在 = 「还没开始积累」→ BOOTSTRAP（与写侧 readLedger 的空起步一致）
      const empty = { version: 1, entries: [] };
      console.log(JSON.stringify({ ok: true, ...queryLedger(empty) }, null, 2));
      process.exit(0);
    }
    fail(`ledger 读取/解析失败（${LEDGER_FILE}）: ${e.message}`);
  }
  let result;
  try {
    result = queryLedger(parsed);
  } catch (e) {
    fail(e.message);
  }
  // 输出**只**由 ledger 内容决定：不落 ledger_file 等环境相关路径（否则同内容不同根会破坏逐字节确定）
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

// isCLI guard（同 sc-preflight 惯例）：被测试/未来消费方 import 时不执行 CLI 入口。
const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCLI) {
  main();
}
