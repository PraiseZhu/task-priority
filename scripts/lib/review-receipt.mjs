// lib/review-receipt.mjs — Phase 4 对抗质询 receipt 的单一实现（P1-B 修复）。
//
// 背景（lead 2026-08-09 实测）：SKILL.md 只有 Phase 4 的 prompt 模板；final-gate 的 GATE_NAMES
// 里没有 adversarial 闸。跳过 Phase 4 直接填结构合法的 manifest → 七闸与 release 全过。
// 「七面有没漏 / n_a 是否敷衍」要到 submit-pr 才首次发现——正是本 skill 要消灭的返工。
//
// 修法（最小形态，lead 裁决）：Phase 4 产出可消费工件 review-receipt.json（与 release-receipt.json
// 同目录同层，写进 ~/.claude/.goal/<slug>/）。最小字段：
//   - slug                          ← 身份绑定（必须 == manifest.slug）
//   - draft_manifest_core_hash      ← 被审草稿的 core hash（谱系键，见下）
//   - gap_catalog_fingerprint       ← 质询消费的 gap-catalog 快照指纹（`gap-catalog-` + sha256 前 10）
//   - ledger_fingerprint            ← 质询消费的台账快照指纹（`ledger-` + sha256 前 10，经 ledger-query
//                                     产出——**复用 lib/ledger-query.mjs，不另写第二份查询**）
//   - reviewer_count                ← sub 数量（正整数）
//   - challenges[]                  ← 逐条 challenge 的 disposition（{challenge, disposition}；
//                                     disposition 如实写「补了哪条 SC」或「无漏项」，语义不机器判）
//
// final-gate 校验（判据所有权归 final-gate）：存在性 + hash 关联。
//   - 文件缺失            → REVIEW_RECEIPT_MISSING
//   - 结构非法/字段缺型    → REVIEW_RECEIPT_INVALID
//   - slug ≠ manifest.slug → REVIEW_RECEIPT_SLUG_MISMATCH
//   - draft_manifest_core_hash ≠ draftAncestorHash(manifest)
//                         → REVIEW_RECEIPT_STALE（旧草稿/质询后改过 SC 未复审——「漂移」）
//   - gap_catalog_fingerprint ≠ 现算 shipped gap-catalog 指纹
//                         → REVIEW_RECEIPT_GAP_CATALOG_MISMATCH（质询消费的不是本仓库当前目录）
//
// 明确不做（lead 裁决，T1）：不校验语义真伪——防的是漏跑，不防敷衍质询；敷衍质询的兜底是三审，
// 计划里已如实声明。ledger_fingerprint 只查存在性+格式（Phase 4 消费的台账快照可能合法地早于
// 当前台账，不能用当前值反推）。
//
// 谱系机制（lib/hashing.mjs 的 draftAncestorHash）：把当前 manifest 还原成草稿形状（剔 final
// 专属键）重算 hash，与 receipt 的 draft_manifest_core_hash 逐字比对。Phase 4 后 SC/coverage 等
// 草稿期字段有变更 ⇒ 祖先 hash 漂移 ⇒ 拒——「补 SC 后没重新质询」不再能静默通过。
//
// CLI（SKILL.md Phase 4 引用同一形态；scaffold 后由 lead 补 challenges/reviewer_count）：
//   node <SKILL_ROOT>/scripts/lib/review-receipt.mjs --draft-manifest <草稿.json> \
//        --ledger-fingerprint <ledger-query 输出的 fingerprint> [--reviewer-count N] [--out <路径>]
// 无 --out → 打印 receipt JSON 到 stdout（lead 复制后补 challenges）；有 --out → 原子写盘。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifestCoreHash, draftAncestorHash } from './hashing.mjs';
// 注：ledger 指纹由 lib/ledger-query.mjs 产出（Phase 1 已跑），本模块只消费其输出形状
// （`ledger-` + 10 hex，见 isFingerprintShape）——不另写第二份查询。

const SKILL_ROOT = process.env.TASK_PRIORITY_SKILL_ROOT
  ? resolve(process.env.TASK_PRIORITY_SKILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const REVIEW_RECEIPT_FILENAME = 'review-receipt.json';
export const GAP_CATALOG_FILENAME = 'gap-catalog.md';

/** 通用指纹：`<prefix>-` + sha256(文本) 前 10 hex（与 ledger-query 的 ledgerFingerprint 同构）。 */
function sha256Prefix(text, prefix) {
  return `${prefix}-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10)}`;
}

/** gap-catalog 指纹：`gap-catalog-` + sha256(文件内容) 前 10 hex（单一实现，禁各处各写一份）。 */
export function gapCatalogFingerprint(gapCatalogText) {
  if (typeof gapCatalogText !== 'string') throw new Error('gapCatalogFingerprint: 输入必须是字符串');
  return sha256Prefix(gapCatalogText, 'gap-catalog');
}

/** 指纹格式校验（gap-catalog- / ledger- 前缀 + 10 hex），供 receipt 结构校验与 CLI 输入校验共用。 */
export function isFingerprintShape(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}-[0-9a-f]{10}$`).test(value);
}

// 前缀名不带尾连字符：isFingerprintShape 模板为 `^<prefix>-[0-9a-f]{10}$`，
// 传 'ledger' 才得到 `^ledger-...`（传 'ledger-' 会拼出双连字符，永远不匹配）
const LEDGER_PREFIX = 'ledger';

/**
 * 校验 review receipt（纯函数，final-gate 的 review-receipt 闸调用）。
 * @param {object|null|undefined} receipt review-receipt.json 内容（null = 文件缺失）
 * @param {object} manifest 当前（final）manifest
 * @param {object} opts {gapCatalogText?} — shipped gap-catalog 内容；缺省/不可读按不匹配处理（fail-closed）
 * @returns {{ok: true} | {ok: false, error_code: string, message: string}}
 */
export function validateReviewReceipt(receipt, manifest, opts = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, error_code: 'REVIEW_RECEIPT_MISSING', message: 'review-receipt.json 缺失（Phase 4 未跑或未落盘）' };
  }
  if (typeof receipt.slug !== 'string' || receipt.slug.length === 0
      || typeof receipt.draft_manifest_core_hash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.draft_manifest_core_hash)
      || !isFingerprintShape(receipt.gap_catalog_fingerprint, 'gap-catalog')
      || !isFingerprintShape(receipt.ledger_fingerprint, LEDGER_PREFIX)
      || !Number.isInteger(receipt.reviewer_count) || receipt.reviewer_count < 1
      || !Array.isArray(receipt.challenges)) {
    return {
      ok: false,
      error_code: 'REVIEW_RECEIPT_INVALID',
      message: 'review-receipt.json 结构非法：slug/draft_manifest_core_hash(64hex)/gap_catalog_fingerprint/ledger_fingerprint/reviewer_count(≥1)/challenges[] 必须齐全',
    };
  }
  for (let i = 0; i < receipt.challenges.length; i += 1) {
    const c = receipt.challenges[i];
    if (!c || typeof c !== 'object' || typeof c.challenge !== 'string' || c.challenge.length === 0
        || typeof c.disposition !== 'string' || c.disposition.length === 0) {
      return {
        ok: false,
        error_code: 'REVIEW_RECEIPT_INVALID',
        message: `review-receipt.json challenges[${i}] 结构非法：每条必须含非空 challenge 与 disposition`,
      };
    }
  }
  if (receipt.slug !== manifest.slug) {
    return {
      ok: false,
      error_code: 'REVIEW_RECEIPT_SLUG_MISMATCH',
      message: `review-receipt.slug=${JSON.stringify(receipt.slug)} ≠ manifest.slug=${JSON.stringify(manifest.slug)}（receipt 张冠李戴）`,
    };
  }
  const ancestor = draftAncestorHash(manifest);
  if (receipt.draft_manifest_core_hash !== ancestor) {
    return {
      ok: false,
      error_code: 'REVIEW_RECEIPT_STALE',
      message: `review-receipt 草稿 hash 漂移：receipt=${String(receipt.draft_manifest_core_hash).slice(0, 12)} ≠ 当前 manifest 草稿祖先=${ancestor.slice(0, 12)}（质询后 SC/coverage 等草稿期字段已变更但未重新质询，回 Phase 4 重审并更新 receipt）`,
    };
  }
  const gapCatalogText = opts.gapCatalogText ?? null;
  if (typeof gapCatalogText !== 'string' || gapCatalogFingerprint(gapCatalogText) !== receipt.gap_catalog_fingerprint) {
    return {
      ok: false,
      error_code: 'REVIEW_RECEIPT_GAP_CATALOG_MISMATCH',
      message: 'review-receipt.gap_catalog_fingerprint ≠ 本仓库 shipped gap-catalog 指纹（质询消费的不是当前弹药库，回 Phase 4 用当前 gap-catalog 重审）',
    };
  }
  return { ok: true };
}

/** 读 SKILL_ROOT/references/gap-catalog.md；缺文件/读失败 → null（调用方按 fail-closed 处理）。 */
export function readShippedGapCatalog() {
  try {
    return readFileSync(join(SKILL_ROOT, 'references', GAP_CATALOG_FILENAME), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 生成 receipt skeleton：draft hash + 两个指纹由本函数内部现算（lead 只传草稿路径与 ledger 指纹），
 * 防手抄/手算指纹造成与 final-gate 判据不一致。返回对象；challenges 留空待 lead 补。
 */
export function scaffoldReviewReceipt({ draftManifest, slug, ledgerFp, reviewerCount = 0 }) {
  if (draftManifest === null || typeof draftManifest !== 'object' || Array.isArray(draftManifest)) {
    throw new Error('scaffoldReviewReceipt: draftManifest 必须是非数组对象');
  }
  if (typeof slug !== 'string' || slug.length === 0) throw new Error('scaffoldReviewReceipt: slug 必填');
  if (!isFingerprintShape(ledgerFp, LEDGER_PREFIX)) {
    throw new Error(`scaffoldReviewReceipt: ledger_fingerprint 必须形如 ledger-<10 hex>（用 ledger-query 输出顶层的 fingerprint）`);
  }
  if (!Number.isInteger(reviewerCount) || reviewerCount < 0) {
    throw new Error('scaffoldReviewReceipt: reviewer_count 必须是非负整数');
  }
  const gapText = readShippedGapCatalog();
  if (typeof gapText !== 'string') {
    throw new Error(`scaffoldReviewReceipt: 读不到 ${GAP_CATALOG_FILENAME}（SKILL_ROOT=${SKILL_ROOT}），无法计算 gap_catalog_fingerprint`);
  }
  return {
    slug,
    draft_manifest_core_hash: manifestCoreHash(draftManifest),
    gap_catalog_fingerprint: gapCatalogFingerprint(gapText),
    ledger_fingerprint: ledgerFp,
    reviewer_count: reviewerCount,
    challenges: [],
  };
}

// ── CLI（scaffold 模式；isCLI guard 同 sc-preflight/ledger-query 惯例）──
function fail(message) {
  console.error(`review-receipt FAIL: ${message}`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--draft-manifest' || a === '--ledger-fingerprint' || a === '--reviewer-count' || a === '--out' || a === '--slug') {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  if (!args['draft-manifest'] || !args['ledger-fingerprint']) {
    fail('用法: review-receipt.mjs --draft-manifest <草稿.json> --ledger-fingerprint <ledger-query fingerprint> [--slug <slug>] [--reviewer-count N] [--out <路径>]');
  }
  let draft;
  try {
    draft = JSON.parse(readFileSync(args['draft-manifest'], 'utf8'));
  } catch (e) {
    fail(`草稿读取/解析失败（${args['draft-manifest']}）: ${e.message}`);
  }
  const slug = args.slug ?? draft.slug ?? null;
  if (!slug) fail('--slug 未传且草稿无 slug');
  const reviewerCount = args['reviewer-count'] === undefined ? 0 : Number(args['reviewer-count']);
  let skeleton;
  try {
    skeleton = scaffoldReviewReceipt({ draftManifest: draft, slug, ledgerFp: args['ledger-fingerprint'], reviewerCount });
  } catch (e) {
    fail(e.message);
  }
  const text = JSON.stringify(skeleton, null, 2) + '\n';
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text, 'utf8');
    console.log(`review-receipt 骨架已写入 ${args.out}（请补 reviewer_count 与 challenges[]）`);
    process.exit(0);
  }
  process.stdout.write(text);
}

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCLI) {
  main();
}
