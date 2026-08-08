#!/usr/bin/env node
// final-gate.mjs — 定序回放 + 双 hash receipts + --release release-gate（计划 Step 10 / SC-9 / F25 / F27）。
//
// 判据所有权（核心机制 C）：双 hash 重算与 receipts 绑定 → 本脚本（经 lib/hashing.mjs）独占。
// 其余闸（manifest-validate / coverage-matrix / waves-plan）各有自己的 owner，本脚本只是
// **定序 wrapper**：前置闸 error 时后继闸记 `not_run`，**不是第二个红**（F27）；error_code 可转述，
// 但不重判（wrapper 不算第二个 owner）。
//
// 定序回放（--slug <slug>，职责一）：
//   1  authority 校验（断路 → AUTHORITY_UNREACHABLE，后面全 not_run）
//   2  回读 task-manifest.json + priority-plan.md，用 lib/hashing 重算双 hash
//      （manifest 落盘的 manifest_core_hash 必须等于重算值——6a 回填后不可再改）
//   3  manifest-validate --stage=final（子进程，转述 error_code）
//   4  coverage-matrix（子进程 --cwd <repo-dir>，转述 error_code）
//   5  waves 一致性：manifest.waves == waves-plan 重算（import buildWavesPlan 复用已加载
//      authority）；dispatch.capacity == authority.capacity
//   6  消费落盘 preflight：无 fabricated、无 infra_fail、green_warn 均有 disposition、
//      exists_not_run 在允许清单内（五态语义归 sc-preflight，这里只做结构性消费）
//   7  最终检查（P1-A/P1-B，2026-08-09；FINAL_CHECK_GATES，不在 GATE_NAMES 内）：
//      a 投影一致性：plan 内 marker 包夹的机器投影区 == manifest 现渲染（逐字节），
//         不等 → PLAN_PROJECTION_MISMATCH / 缺 marker → PLAN_PROJECTION_MISSING
//      b review-receipt：Phase 4 对抗质询工件存在 + 草稿 hash 对得上当前 manifest 谱系
//         （draftAncestorHash）+ gap-catalog 指纹现算比对（缺失/漂移 → 拒）
//   8  全过 → 把 receipts（绑 slug + manifest_core_hash + plan_hash）追加写进 task-manifest.json
//      （receipts 键是 core hash 黑名单排除键 → 不动点）→ 输出 LIVE_ROUND_OK
//
// release-gate（--slug <slug> --release，职责二，消除 TOCTOU）：
//   ① 从磁盘取**同一次快照**回读 plan + manifest（不用内存副本）
//   ② 重算双 hash，与 receipts（最后一条）逐字比对
//   ③ 校验 manifest.slug == 目标 slug（身份绑定）
//   ④ 全部匹配 → **从该已验证快照**读取 dispatch.packets 文本输出（可投递）
//      → 写 release-receipt.json（canonical_repo/branch/pr_number/binding_strength/base_sha/released_at）
//   ⑤ 任一漂移 → exit 2，提示回 Phase 2/5 重走
//
// release-receipt 字段来源（v7 口径，别用旧版）：
//   canonical_repo ← lib/repo-identity.mjs 的 canonicalRepo({cwd}) **离线派生**（F38-B，gh 不在关键路径）
//   branch         ← git rev-parse --abbrev-ref HEAD
//   pr_number      ← --pr-number 显式传，或经 gh 探测 draft PR；gh 不可用 → null（weak，不阻断）
//   binding_strength ← pr_number 非 null 且 gh 探测可用 = 'strong'，否则 'weak'（报告须标注）
//   base_sha       ← 仅诊断（merge-base HEAD origin/main，失败回退 rev-parse HEAD），不做等值检查
//
// 产物目录：--goal-dir 即产物目录本身（默认 ~/.claude/.goal/<slug>/），直接含 task-manifest.json /
// priority-plan.md / release-receipt.json —— 不要传父目录（传父目录会 LOAD_FAILED，实测坑）。
// 测试请注入 goal-dir 指向 tmp。
//
// 用法：
//   node scripts/final-gate.mjs --slug <slug> [--goal-dir <dir>] [--repo-dir <dir>]
//   node scripts/final-gate.mjs --slug <slug> --release [--goal-dir <dir>] [--repo-dir <dir>] [--pr-number <n>]
//
// 退出码：全过 exit 0；任何违规 exit 2（stderr 列逐闸事件集 + 错误消息）。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAuthority } from './lib/authority.mjs';
import { manifestCoreHash, planHash } from './lib/hashing.mjs';
import { renderPlanProjection, extractPlanProjection } from './lib/plan-projection.mjs';
import { REVIEW_RECEIPT_FILENAME, validateReviewReceipt, readShippedGapCatalog } from './lib/review-receipt.mjs';
import { canonicalRepo } from './lib/repo-identity.mjs';
import { buildWavesPlan } from './waves-plan.mjs';
import { verifyFingerprint } from './sc-preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = dirname(HERE);

export const MANIFEST_FILENAME = 'task-manifest.json';
export const PLAN_FILENAME = 'priority-plan.md';
export const RELEASE_RECEIPT_FILENAME = 'release-receipt.json';

/** preflight 五态中「允许出现」的状态（结构性消费；语义真伪归 sc-preflight / Phase 4） */
export const PREFLIGHT_ALLOWED_STATUSES = ['red_ok', 'green_warn', 'exists_not_run'];

/** 事件闸名序列（定序语义：任一 error 后，其后的闸全部 not_run） */
export const GATE_NAMES = ['authority', 'load', 'hashes', 'manifest-validate', 'coverage-matrix', 'waves', 'preflight'];

/**
 * 最终检查闸（P1-A/P1-B，2026-08-09）：**刻意不在 GATE_NAMES 内**。
 * 语义：七闸**全过后**才评估（任何前置 error → 最终检查不出现，错误路径事件集保持不变——
 * reverse-mutation.test.mjs 的 F3 走查按「恰好 7 条事件」锁定，且「前置闸红时其后全部 not_run」
 * 只对 GATE_NAMES 内的闸成立）。任一最终检查 error → 拒且不写 receipts（同前七闸）。
 */
export const FINAL_CHECK_GATES = ['projection', 'review-receipt'];

export function defaultGoalDir(slug) {
  return join(homedir(), '.claude', '.goal', slug);
}

function goalPaths(goalDir, slug) {
  return {
    manifestPath: join(goalDir, MANIFEST_FILENAME),
    planPath: join(goalDir, PLAN_FILENAME),
    releaseReceiptPath: join(goalDir, RELEASE_RECEIPT_FILENAME),
    reviewReceiptPath: join(goalDir, REVIEW_RECEIPT_FILENAME),
  };
}

function readJsonFile(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = join(mkdtempSync(join(tmpdir(), 'final-gate-')), 'out.json');
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * 子进程跑闸：exit 0 → ok；否则 error，error_code 从 stderr 提取（提不到用 fallback）。
 * 取第一个 [CODE]（F3，2026-08-09）：
 *   - coverage-matrix 违规行自带方括号码（`<task> <kind> <dim> [CODE]`），第一条 = owner 原码
 *     （此前取最后一个，把无方括号的 COVERAGE_CELL_MISSING 吞成 generic COVERAGE_MATRIX_FAIL，
 *     消费者无法精确回哪个 Phase 修——违反核心机制 C 的「前置闸红 → 后继转述同一 error_code」）
 *   - manifest-validate 的 FAIL 摘要行不含 [CODE]，逐条违规行以 `[CODE]` 开头，
 *     第一个命中就是 owner 码（2026-08-09 已实测贴出完整 stderr，见交付报告）
 */
function runSubprocess(args, fallbackCode) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status === 0) return { ok: true, error_code: null, stderr: r.stderr };
  const m = /\[([A-Z][A-Z0-9_]+)\]/.exec(r.stderr || '');
  return { ok: false, error_code: m ? m[1] : fallbackCode, stderr: (r.stderr || '').slice(0, 800) };
}

function gitRun(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** gh 探测 draft PR：成功 → {prNumber, ghAvailable:true}；gh 缺失/失败 → {prNumber:null, ghAvailable:false} */
function probePrNumber(canonicalRepoName, branch) {
  try {
    const r = spawnSync(
      'gh',
      ['pr', 'list', '--repo', canonicalRepoName, '--head', branch, '--state', 'open', '--json', 'number'],
      { encoding: 'utf8', timeout: 15000 },
    );
    if (r.status !== 0) return { prNumber: null, ghAvailable: false };
    const arr = JSON.parse(r.stdout);
    return { prNumber: Array.isArray(arr) && arr.length > 0 ? String(arr[0].number) : null, ghAvailable: true };
  } catch {
    return { prNumber: null, ghAvailable: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 职责一：定序回放（6c）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   - slug: 目标 slug（必填）
 *   - goalDir: 产物目录（默认 ~/.claude/.goal/<slug>）
 *   - repoDir: git 仓目录（coverage-matrix 的 cwd 与 release 的 repo 身份；默认 process.cwd()）
 *   - configPath: authority 配置注入（测试断路用）
 *   - now: 时间注入（测试）
 * @returns {Promise<{ok, events, manifest_core_hash?, plan_hash?, manifestPath?, planPath?, error?}>}
 *   events: [{gate, status: 'ok'|'error'|'not_run', error_code?}]，按定序语义生成。
 */
export async function runFinalGate({ slug, goalDir, repoDir, configPath, now }) {
  const gd = goalDir ?? defaultGoalDir(slug);
  const rd = repoDir ?? process.cwd();
  const { manifestPath, planPath, reviewReceiptPath } = goalPaths(gd, slug);
  const events = [];
  const mark = (gate, status, error_code = null) => events.push({ gate, status, error_code });
  const fail = (error) => ({ ok: false, events, error });
  const stopped = () => events.filter((e) => e.status === 'error').length > 0;

  // ── 1) authority 校验（断路 → 后面全 not_run）──
  let authority = null;
  try {
    authority = await loadAuthority({ configPath });
    mark('authority', 'ok');
  } catch (e) {
    mark('authority', 'error', 'AUTHORITY_UNREACHABLE');
    for (const g of GATE_NAMES.slice(1)) mark(g, 'not_run');
    return fail(`authority 断路: ${e.message}`);
  }

  // ── 2) 回读双产物 + 重算双 hash（load 失败 → 后面全 not_run）──
  let manifest = null;
  let planText = null;
  try {
    if (!existsSync(manifestPath)) throw new Error(`task-manifest.json 不存在: ${manifestPath}`);
    if (!existsSync(planPath)) throw new Error(`priority-plan.md 不存在: ${planPath}`);
    manifest = readJsonFile(manifestPath);
    planText = readFileSync(planPath, 'utf8');
    mark('load', 'ok');
  } catch (e) {
    mark('load', 'error', 'LOAD_FAILED');
    for (const g of GATE_NAMES.slice(2)) mark(g, 'not_run');
    return fail(`回读双产物失败: ${e.message}`);
  }

  let coreHash;
  let planHashValue;
  try {
    coreHash = manifestCoreHash(manifest);
    planHashValue = planHash(planText);
    mark('hashes', 'ok');
  } catch (e) {
    mark('hashes', 'error', 'HASH_COMPUTE_FAILED');
    for (const g of GATE_NAMES.slice(3)) mark(g, 'not_run');
    return fail(`hash 计算失败: ${e.message}`);
  }
  // 落盘 manifest_core_hash 必须等于重算值（6a 回填后不可再改；不等 = 快照漂移）
  if (manifest.manifest_core_hash !== coreHash) {
    mark('hashes', 'error', 'HASH_MISMATCH');
    for (const g of GATE_NAMES.slice(3)) mark(g, 'not_run');
    return fail(
      `manifest_core_hash 漂移: 落盘=${String(manifest.manifest_core_hash).slice(0, 12)} ≠ 重算=${coreHash.slice(0, 12)}（回 Phase 2/5 重走）`,
    );
  }
  if (manifest.slug !== slug) {
    mark('hashes', 'error', 'SLUG_MISMATCH');
    for (const g of GATE_NAMES.slice(3)) mark(g, 'not_run');
    return fail(`manifest.slug=${manifest.slug} ≠ 目标 slug=${slug}`);
  }

  // ── 3) manifest-validate --stage=final ──
  const mv = runSubprocess(
    [join(HERE, 'manifest-validate.mjs'), '--manifest', manifestPath, '--stage=final'],
    'MANIFEST_VALIDATE_FAIL',
  );
  mark('manifest-validate', mv.ok ? 'ok' : 'error', mv.ok ? null : mv.error_code);
  if (!mv.ok) {
    for (const g of GATE_NAMES.slice(4)) mark(g, 'not_run');
    return fail(`manifest-validate(final) 违规 [${mv.error_code}]: ${mv.stderr}`);
  }

  // ── 4) coverage-matrix（--cwd 钉死 repoDir，避免依赖调用方 cwd）──
  const cm = runSubprocess(
    [join(HERE, 'coverage-matrix.mjs'), '--manifest', manifestPath, '--cwd', rd],
    'COVERAGE_MATRIX_FAIL',
  );
  mark('coverage-matrix', cm.ok ? 'ok' : 'error', cm.ok ? null : cm.error_code);
  if (!cm.ok) {
    for (const g of GATE_NAMES.slice(5)) mark(g, 'not_run');
    return fail(`coverage-matrix 违规 [${cm.error_code}]: ${cm.stderr}`);
  }

  // ── 5) waves 一致性：落盘 == 重算；capacity == authority 现读 ──
  let wavesOk = true;
  let wavesCode = null;
  let wavesMsg = '';
  try {
    const recomputed = await buildWavesPlan({ scs: manifest.scs, authority });
    if (!isDeepStrictEqual(recomputed.waves, manifest.waves)) {
      wavesOk = false;
      wavesCode = 'WAVES_MISMATCH';
      wavesMsg = '落盘 waves ≠ waves-plan 重算（回 Phase 5 重新落盘）';
    } else if (recomputed.capacity !== authority.capacity || manifest.dispatch?.capacity !== authority.capacity) {
      wavesOk = false;
      wavesCode = 'CAPACITY_MISMATCH';
      wavesMsg = `capacity: 重算=${recomputed.capacity} 落盘=${manifest.dispatch?.capacity} authority=${authority.capacity}`;
    }
  } catch (e) {
    wavesOk = false;
    wavesCode = 'WAVES_PLAN_ERROR';
    wavesMsg = `waves-plan 重算失败: ${e.message}`;
  }
  mark('waves', wavesOk ? 'ok' : 'error', wavesOk ? null : wavesCode);
  if (!wavesOk) {
    for (const g of GATE_NAMES.slice(6)) mark(g, 'not_run');
    return fail(`waves 一致性违规 [${wavesCode}]: ${wavesMsg}`);
  }

  // ── 6) 消费落盘 preflight（P0#3，2026-08-09）：
  //        执行凭据绑定——receipt 必须由 sc-preflight 对「当前 manifest 的同一 SC + 同一 verify 命令」
  //        产出，缺 receipt / sc_id 不符 / 指纹缺失 / 指纹不匹配均拒（防「忘了跑」和「命令换了没重跑」）。
  //        然后才是状态语义检查：无 fabricated / 无 infra_fail / green_warn 有 disposition /
  //        exists_not_run 在允许清单内（五态语义仍归 sc-preflight 独占判定）。
  //        repo_head 仅诊断，不作等值判据（rebase 后合法变化，同 base_sha 处理）。──
  let pfOk = true;
  let pfCode = null;
  let pfMsg = '';
  for (const sc of manifest.scs ?? []) {
    const pf = sc.preflight;
    if (!pf || typeof pf.status !== 'string') {
      pfOk = false;
      pfCode = 'PREFLIGHT_INVALID';
      pfMsg = `SC ${sc.id} 缺 preflight 记录`;
      break;
    }
    // P0#3：receipt 必须绑定到被验对象（防张冠李戴——把别的 SC 的 receipt 贴过来）
    if (pf.sc_id !== sc.id) {
      pfOk = false;
      pfCode = 'PREFLIGHT_SC_ID_MISMATCH';
      pfMsg = `SC ${sc.id} preflight.sc_id=${JSON.stringify(pf.sc_id)} ≠ ${sc.id}（receipt 必须由 sc-preflight 对该 SC 产出）`;
      break;
    }
    // P0#3：必须携带 verify 命令指纹，且与当前 manifest 该 SC 的 verify 命令重算指纹一致
    //       （缺指纹 = 手写 status 冒充；指纹不等 = verify 命令已变更但未重跑 preflight）
    if (typeof pf.verify_fingerprint !== 'string' || pf.verify_fingerprint.length === 0) {
      pfOk = false;
      pfCode = 'PREFLIGHT_FINGERPRINT_MISSING';
      pfMsg = `SC ${sc.id} preflight 缺 verify_fingerprint（须由 sc-preflight 产出，不得手写 status 冒充已空跑）`;
      break;
    }
    const currentFp = verifyFingerprint(sc.verify?.cmd, sc.verify?.args);
    if (pf.verify_fingerprint !== currentFp) {
      pfOk = false;
      pfCode = 'PREFLIGHT_FINGERPRINT_MISMATCH';
      pfMsg = `SC ${sc.id} verify 命令指纹不匹配：receipt=${pf.verify_fingerprint} ≠ 当前命令重算=${currentFp}（verify 已变更但未重跑 preflight，回 Phase 5 重跑）`;
      break;
    }
    if (pf.status === 'fabricated') {
      pfOk = false;
      pfCode = 'PREFLIGHT_FABRICATED';
      pfMsg = `SC ${sc.id} preflight 为 fabricated（编造的命令，回 Phase 5 重跑）`;
      break;
    }
    if (pf.status === 'infra_fail') {
      pfOk = false;
      pfCode = 'PREFLIGHT_INFRA_FAIL';
      pfMsg = `SC ${sc.id} preflight 为 infra_fail（fail-closed，回 Phase 5 重跑）`;
      break;
    }
    if (pf.status === 'green_warn' && (typeof pf.disposition !== 'string' || !pf.disposition.trim())) {
      pfOk = false;
      pfCode = 'PREFLIGHT_GREEN_WARN_NO_DISPOSITION';
      pfMsg = `SC ${sc.id} preflight 为 green_warn 但缺 disposition（空转嫌疑必须由 lead 处置）`;
      break;
    }
    if (!PREFLIGHT_ALLOWED_STATUSES.includes(pf.status)) {
      pfOk = false;
      pfCode = 'PREFLIGHT_UNKNOWN_STATUS';
      pfMsg = `SC ${sc.id} preflight 状态 "${pf.status}" 不在允许清单（${PREFLIGHT_ALLOWED_STATUSES.join('/')}）`;
      break;
    }
  }
  mark('preflight', pfOk ? 'ok' : 'error', pfOk ? null : pfCode);
  if (!pfOk) return fail(`preflight 消费违规 [${pfCode}]: ${pfMsg}`);

  // ── 7) 最终检查（P1-A/P1-B，2026-08-09）：七闸全过后才评估 ──
  //     ① 投影一致性：从 manifest **现渲染**投影区，与 plan 内 marker 区块逐字节比对。
  //        不等即拒（PLAN_PROJECTION_MISMATCH）——marker 区是机器事实区，自由散文不受约束。
  //     ② review-receipt：Phase 4 对抗质询的可消费工件。存在性 + 草稿 hash 谱系关联
  //        （draftAncestorHash 见 lib/hashing.mjs）+ gap-catalog 指纹现算比对。
  //     两闸任一 error → 拒且不写 receipts（与前置闸同权；FINAL_CHECK_GATES 不在 GATE_NAMES
  //     内，故错误路径的事件集不追加 not_run 条目——见 FINAL_CHECK_GATES 注释）。
  let projOk = true;
  let projCode = null;
  let projMsg = '';
  try {
    const rendered = renderPlanProjection(manifest);
    const inPlan = extractPlanProjection(planText);
    if (inPlan === null) {
      projOk = false;
      projCode = 'PLAN_PROJECTION_MISSING';
      projMsg = 'priority-plan.md 缺机器投影区（marker 未找到）——Phase 6b 必须用 renderPlanProjection 渲染并回填';
    } else if (inPlan !== rendered) {
      projOk = false;
      projCode = 'PLAN_PROJECTION_MISMATCH';
      projMsg = 'priority-plan.md 投影区 ≠ manifest 现渲染（双产物语义漂移：marker 区内由 manifest 确定性渲染、勿手改，回 Phase 6b 重新渲染）';
    }
  } catch (e) {
    projOk = false;
    projCode = 'PLAN_PROJECTION_ERROR';
    projMsg = `投影渲染失败: ${e.message}`;
  }
  mark('projection', projOk ? 'ok' : 'error', projOk ? null : projCode);
  if (!projOk) {
    mark('review-receipt', 'not_run');
    return fail(`投影一致性违规 [${projCode}]: ${projMsg}`);
  }

  let rrOk = true;
  let rrCode = null;
  let rrMsg = '';
  let rr = null;
  try {
    rr = JSON.parse(readFileSync(reviewReceiptPath, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      rrOk = false;
      rrCode = 'REVIEW_RECEIPT_INVALID';
      rrMsg = `review-receipt.json 读取/解析失败: ${e.message}`;
    }
    // ENOENT → rr 保持 null → validateReviewReceipt 判 REVIEW_RECEIPT_MISSING
  }
  if (rrOk) {
    const v = validateReviewReceipt(rr, manifest, { gapCatalogText: readShippedGapCatalog() });
    rrOk = v.ok;
    rrCode = v.error_code;
    rrMsg = v.message;
  }
  mark('review-receipt', rrOk ? 'ok' : 'error', rrOk ? null : rrCode);
  if (!rrOk) return fail(`review-receipt 违规 [${rrCode}]: ${rrMsg}`);

  // ── 8) 全过 → 写 receipts（绑 slug + 双 hash；receipts 键是 core hash 黑名单 → 不动点）──
  const receipt = {
    slug,
    manifest_core_hash: coreHash,
    plan_hash: planHashValue,
    recorded_at: (now ?? new Date()).toISOString(),
  };
  const newManifest = { ...manifest, receipts: [...(manifest.receipts ?? []), receipt] };
  writeJsonAtomic(manifestPath, newManifest);
  return { ok: true, events, manifest_core_hash: coreHash, plan_hash: planHashValue, manifestPath, planPath, receipt };
}

// ─────────────────────────────────────────────────────────────────────────────
// 职责二：release-gate（6d，消除 TOCTOU）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts 同 runFinalGate + prNumber（显式 PR 号）
 * @returns {Promise<{ok, mismatches?, events?, releaseReceipt?, packets?, error?}>}
 *   ok:true 时 packets = 已验证快照里的 dispatch.packets（可投递文本），releaseReceipt 已写盘。
 */
export async function runReleaseGate({ slug, goalDir, repoDir, prNumber, now }) {
  const gd = goalDir ?? defaultGoalDir(slug);
  const rd = repoDir ?? process.cwd();
  const { manifestPath, planPath, releaseReceiptPath } = goalPaths(gd, slug);
  const mismatches = [];

  // ① 从磁盘取同一次快照回读 plan + manifest（不用内存副本）
  let manifest;
  let planText;
  try {
    manifest = readJsonFile(manifestPath);
    planText = readFileSync(planPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `release-gate: 回读快照失败: ${e.message}（回 Phase 6c 重走）` };
  }

  // ② 重算双 hash，与 receipts（最后一条）逐字比对
  const coreHash = manifestCoreHash(manifest);
  const planHashValue = planHash(planText);
  const receipts = manifest.receipts;
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { ok: false, error: 'release-gate: manifest 无 receipts（先跑 final-gate 写 receipts 再 release）' };
  }
  const receipt = receipts[receipts.length - 1];
  if (receipt.slug !== slug) mismatches.push(`slug: receipt=${receipt.slug} ≠ 目标=${slug}`);
  if (receipt.manifest_core_hash !== coreHash) {
    mismatches.push(`manifest_core_hash: receipt=${String(receipt.manifest_core_hash).slice(0, 12)} ≠ 重算=${coreHash.slice(0, 12)}`);
  }
  if (receipt.plan_hash !== planHashValue) {
    mismatches.push(`plan_hash: receipt=${String(receipt.plan_hash).slice(0, 12)} ≠ 重算=${planHashValue.slice(0, 12)}`);
  }

  // ③ 校验 manifest.slug == 目标 slug（身份绑定）
  if (manifest.slug !== slug) mismatches.push(`manifest.slug=${manifest.slug} ≠ 目标=${slug}`);

  if (mismatches.length > 0) {
    return {
      ok: false,
      mismatches,
      error: `release-gate: 快照漂移（${mismatches.join('; ')}）——回 Phase 2/5 重走，旧 receipts 已失效`,
    };
  }

  // ④ 从该已验证快照输出 packet + 写 release-receipt
  let canonicalRepoName;
  try {
    canonicalRepoName = canonicalRepo({ cwd: rd });
  } catch (e) {
    return { ok: false, error: `release-gate: canonical_repo 离线派生失败: ${e.message}` };
  }
  const branch = gitRun(rd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) {
    return { ok: false, error: `release-gate: 无法取得分支名（${rd} 不是可用的 git 仓）` };
  }
  const probe = probePrNumber(canonicalRepoName, branch);
  const pr = prNumber ?? probe.prNumber;
  const baseSha =
    gitRun(rd, ['merge-base', 'HEAD', 'origin/main']) ?? gitRun(rd, ['rev-parse', 'HEAD']) ?? 'unavailable';

  const releaseReceipt = {
    slug,
    manifest_core_hash: coreHash,
    plan_hash: planHashValue,
    canonical_repo: canonicalRepoName,
    branch,
    pr_number: pr,
    binding_strength: pr !== null && pr !== undefined && probe.ghAvailable ? 'strong' : 'weak',
    base_sha: baseSha, // 仅诊断，不做等值检查（rebase 后合法变化）
    released_at: (now ?? new Date()).toISOString(),
  };
  writeJsonAtomic(releaseReceiptPath, releaseReceipt);
  return {
    ok: true,
    releaseReceipt,
    packets: manifest.dispatch.packets, // 已验证快照里的 packet 文本（可投递）
    binding_weak: releaseReceipt.binding_strength === 'weak',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--release') {
      args.release = true;
    } else if (a === '--slug' || a === '--goal-dir' || a === '--repo-dir' || a === '--pr-number') {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      const k = a.slice(2);
      args[k] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function emitEvents(events) {
  process.stdout.write(JSON.stringify({ gates: events }, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) {
    process.stderr.write(
      '用法: node scripts/final-gate.mjs --slug <slug> [--goal-dir <dir>] [--repo-dir <dir>]\n' +
        '      node scripts/final-gate.mjs --slug <slug> --release [--goal-dir <dir>] [--repo-dir <dir>] [--pr-number <n>]\n',
    );
    process.exit(2);
  }
  const opts = {
    slug: args.slug,
    goalDir: args['goal-dir'],
    repoDir: args['repo-dir'],
  };

  if (args.release) {
    const r = await runReleaseGate({ ...opts, prNumber: args['pr-number'] });
    if (!r.ok) {
      process.stderr.write(`final-gate: RELEASE_FAIL\n${r.error ?? ''}\n`);
      if (r.mismatches) for (const m of r.mismatches) process.stderr.write(`  - ${m}\n`);
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(r.packets, null, 2)}\n`);
    if (r.binding_weak) {
      process.stderr.write('final-gate: 提示 — binding_strength=weak（无 PR 号或 gh 不可用），配对声称按条件收窄\n');
    }
    process.exit(0);
  }

  const r = await runFinalGate(opts);
  if (!r.ok) {
    process.stderr.write('final-gate: FAIL\n');
    for (const e of r.events) {
      process.stderr.write(`  [${e.gate}] ${e.status}${e.error_code ? ` ${e.error_code}` : ''}\n`);
    }
    process.stderr.write(`${r.error ?? ''}\n`);
    process.exit(2);
  }
  emitEvents(r.events);
  process.stdout.write(
    `receipt: slug=${r.receipt.slug} manifest_core_hash=${r.receipt.manifest_core_hash} plan_hash=${r.receipt.plan_hash} recorded_at=${r.receipt.recorded_at}\n`,
  );
  process.stdout.write('LIVE_ROUND_OK\n');
  process.exit(0);
}

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCLI) {
  main();
}
