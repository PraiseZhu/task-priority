#!/usr/bin/env node
// gap-backfill.mjs — 回流对账器（计划核心机制 D / SC-10 / Phase 7）。
//
// 定位：**提示式回流**，不接线进 submit-pr、不声称自动闭环。三审查出但清单没预测到的
// finding = 逃逸，按根因指纹入台账，下一轮自动变成对抗质询的弹药。
//
// 五道依序检查（顺序不可换，任一失败 exit 2）：
//   ① release-receipt 身份/新鲜度：receipt.slug / manifest_core_hash / plan_hash 与
//      当前回读双产物重算值逐字一致，且当前仓 canonical 身份 == receipt.canonical_repo
//      （经 lib/repo-identity.mjs 从 `git remote get-url origin` **离线**派生，不调 gh）。
//   ② 必传 --expect-manifest-hash，与落盘 manifest 重算值比对（manifest 没被换/没被改）。
//   ③ artifact 自洽：recomputeArtifactHash(artifact) === artifact.consensus_artifact_hash
//      （artifact 内容——含 canonical_findings——未被改动）。
//   ④ (canonical_repo, branch) 主关联：`gh pr view --repo <receipt.canonical_repo>
//      <artifact.pr_number> --json headRefName,headRepositoryOwner` →
//      headRefName 必须 == receipt.branch；headRepositoryOwner 必须 == canonical_repo 的
//      owner（v1 不支持 fork，F39，不等即 fail-closed 拒）。**gh 必须显式 --repo、不靠 cwd
//      推断；本检查是唯一依赖 gh 的一道**。artifact.pr_number 为 null 或 gh 缺失 → 本检查
//      不可执行 → 须显式 --allow-weak-binding 且报告标注弱绑定（F38：降级路径真实可执行）。
//   ⑤ pr_number 等值（辅助键，仅当 receipt.pr_number 与 artifact.pr_number **两侧都非 null**）。
//
// base_sha 只作诊断：不一致时人工复核段出一行提示，**不 exit 2**（rebase 后合法变化，
// 等值检查会假拒绝）。可选 --expect-round：显式声明期望轮次，与 artifact.round 不等即拒。
//
// 对账键 = (A.familyKeyOf(invariant), primary_face)。输入**只认 consensus artifact 的
// canonical_findings**（不吃原始 verdict——canonical 才是冻结后的共识文本，由③保证
// artifact 是自洽的 consensus artifact）。预测集来自 manifest 的 `scs[].predicted_invariant`
// 经**同一个** A.familyKeyOf 派生 + `predicted_primary_face`。命中 → 不入账；未命中 →
// 逃逸 → 经 evolution-note add 入账（fingerprint 去重自增，默认不 push）；未命中项另进
// 「人工复核段」列全。
//
// ★措辞纪律（如实声明残余）★：机器层只做 **exact-key** 对账——同一 invariant 的不同
// 措辞（同义改写）会得到不同的 family key，产生**假阴**（逃逸未检出）。这是已知残余：
// 同义改写的逃逸只能靠人工复核段 + lead 扫视发现，脚本不声称语义对账。
//
// 用法：
//   gap-backfill.mjs --manifest <task-manifest.json> --plan <priority-plan.md>
//                    --artifact <consensus-artifact.json> --receipt <release-receipt.json>
//                    --expect-manifest-hash <hash>
//                    [--expect-round <N>] [--allow-weak-binding]
//
// 测试隔离：环境变量 TASK_PRIORITY_SKILL_ROOT 重定向台账根（透传给 evolution-note）；
// GAP_BACKFILL_GH 覆盖 gh 可执行路径（测试 stub 注入，不真查 GitHub）。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthority } from './lib/authority.mjs';
import { manifestCoreHash, planHash } from './lib/hashing.mjs';
import { canonicalRepo } from './lib/repo-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// evolution-note 的脚本路径固定在真实 scripts/ 目录；台账根由 TASK_PRIORITY_SKILL_ROOT
// 环境变量重定向（父进程已设置时透传给子进程）——测试用临时目录隔离真台账。
const EVOLUTION_NOTE = join(HERE, 'evolution-note.mjs');

const GH_BIN = process.env.GAP_BACKFILL_GH || 'gh';

const fail = (msg) => {
  console.error(`gap-backfill FAIL: ${msg}`);
  process.exit(2);
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : null;
}

function readJson(filePath, what) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`${what} 读取/解析失败(${filePath}): ${e.message}`);
  }
}

/** 逃逸条目的确定性 fingerprint：`esc-` + sha256(familyKey|primary_face) 前 10 hex。 */
function escapeFingerprint(familyKey, primaryFace) {
  return `esc-${createHash('sha256').update(`${familyKey}|${primaryFace}`, 'utf8').digest('hex').slice(0, 10)}`;
}

/**
 * 调用 gh 反查 PR head 信息（检查④专用）。
 * 返回 {ok:true, headRefName, headRepositoryOwner}；gh 可执行缺失 → {ok:false, reason:'gh-missing'}；
 * gh 存在但命令失败 → 抛错（显式查询失败，fail-closed，不是 weak）。
 */
function ghPrView(repo, prNumber) {
  let out;
  try {
    out = execFileSync(GH_BIN, ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefName,headRepositoryOwner'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'gh-missing' };
    throw new Error(`gh pr view 失败（显式查询失败，fail-closed）: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`gh pr view 输出非 JSON（fail-closed）: ${String(out).slice(0, 200)}`);
  }
  return { ok: true, headRefName: parsed.headRefName, headRepositoryOwner: parsed.headRepositoryOwner };
}

/** 逃逸入账：经 evolution-note add（无 --sync → 台账默认零对外副作用）。返回 {added, updated, sync}。 */
function recordEscapes(escapes) {
  let added = 0;
  let updated = 0;
  let sync = null;
  for (const esc of escapes) {
    const fingerprint = escapeFingerprint(esc.familyKey, esc.primaryFace);
    // tier 默认 proposal（逃逸处理策略由维护者拍板，永不自动落地）；gap-backfill 不接收入账 tier 覆盖
    const args = [
      EVOLUTION_NOTE,
      'add',
      '--fingerprint', fingerprint,
      '--tier', 'proposal',
      '--title', `清单未预测到的 finding: ${String(esc.invariant ?? esc.canonical_key ?? '?').slice(0, 80)}`,
      '--detail', `familyKey=${esc.familyKey} primary_face=${esc.primaryFace}（三审才暴露，清单预测集未覆盖）`,
    ];
    const out = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }, // 透传 TASK_PRIORITY_SKILL_ROOT（若父进程设置了），台账根与真台账隔离
    });
    const res = JSON.parse(out);
    if (res.ok) {
      if (res.isNew) added += 1; else updated += 1;
      sync = res.sync ?? sync;
    } else {
      throw new Error(`逃逸入账失败: ${JSON.stringify(res)}`);
    }
  }
  return { added, updated, sync };
}

async function main() {
  const manifestPath = arg('manifest');
  const planPath = arg('plan');
  const artifactPath = arg('artifact');
  const receiptPath = arg('receipt');
  const expectManifestHash = arg('expect-manifest-hash');
  const expectRoundRaw = arg('expect-round');
  const allowWeak = process.argv.includes('--allow-weak-binding');

  for (const [flag, val] of [['--manifest', manifestPath], ['--plan', planPath], ['--artifact', artifactPath], ['--receipt', receiptPath], ['--expect-manifest-hash', expectManifestHash]]) {
    if (!val) fail(`缺少必传参数 ${flag}`);
  }
  const expectRound = expectRoundRaw != null ? Number(expectRoundRaw) : null;

  // ── 对账键派生：familyKeyOf / recomputeArtifactHash 必须经 authority（不自造）──
  let A;
  try {
    A = await loadAuthority();
  } catch (e) {
    fail(`AUTHORITY_UNREACHABLE: ${e.message}`);
  }

  const manifest = readJson(manifestPath, 'manifest');
  const planText = (() => {
    try { return readFileSync(planPath, 'utf8'); } catch (e) { fail(`plan 读取失败: ${e.message}`); }
  })();
  const artifact = readJson(artifactPath, 'artifact');
  const receipt = readJson(receiptPath, 'release-receipt');

  const checks = {};
  const manualReview = [];
  const notes = [];

  // ── 检查①：release-receipt 身份/新鲜度（F31/F36/F38-B，离线，不依赖 gh）──
  {
    const coreHash = manifestCoreHash(manifest);
    const planHashValue = planHash(planText);
    let repoIdentity;
    try {
      repoIdentity = canonicalRepo({ cwd: process.cwd() });
    } catch (e) {
      fail(`检查① 当前仓 canonical 身份派生失败（lib/repo-identity 离线路径）: ${e.message}`);
    }
    const mismatches = [];
    if (receipt.slug !== manifest.slug) mismatches.push(`slug: receipt=${receipt.slug} ≠ manifest=${manifest.slug}`);
    if (receipt.manifest_core_hash !== coreHash) mismatches.push(`manifest_core_hash: receipt=${String(receipt.manifest_core_hash).slice(0, 12)} ≠ 重算=${coreHash.slice(0, 12)}`);
    if (receipt.plan_hash !== planHashValue) mismatches.push(`plan_hash: receipt=${String(receipt.plan_hash).slice(0, 12)} ≠ 重算=${planHashValue.slice(0, 12)}`);
    if (receipt.canonical_repo !== repoIdentity) mismatches.push(`canonical_repo: receipt=${receipt.canonical_repo} ≠ 当前仓=${repoIdentity}`);
    checks['1_identity_freshness'] = {
      ok: mismatches.length === 0,
      canonical_repo: repoIdentity,
      receipt_canonical_repo: receipt.canonical_repo,
      mismatches,
    };
    if (mismatches.length) fail(`检查① release-receipt 身份/新鲜度不符: ${mismatches.join('; ')}`);
  }

  // ── 检查②：--expect-manifest-hash 与落盘重算比对 ──
  {
    const coreHash = manifestCoreHash(manifest);
    const ok = expectManifestHash === coreHash;
    checks['2_expect_manifest_hash'] = { ok, expect: expectManifestHash.slice(0, 12), recomputed: coreHash.slice(0, 12) };
    if (!ok) fail('检查② --expect-manifest-hash 与落盘 manifest 重算值不符（manifest 被换/被改）');
  }

  // ── 检查③：artifact 自洽（F31）──
  {
    let recomputed = null;
    try {
      recomputed = A.recomputeArtifactHash(artifact);
    } catch (e) {
      fail(`检查③ artifact 结构非法，hash 重算失败（fail-closed）: ${e.message}`);
    }
    const ok = recomputed === artifact.consensus_artifact_hash;
    checks['3_artifact_self_consistent'] = { ok, recomputed: recomputed.slice(0, 12), claimed: String(artifact.consensus_artifact_hash).slice(0, 12) };
    if (!ok) fail('检查③ artifact 自身 hash 与内容重算不符（canonical_findings 被篡改/未重算）');
  }

  // ── 检查④：(canonical_repo, branch) 主关联（F36，唯一依赖 gh 的一道；F39 拒 fork）──
  const binding = { strength: 'strong', reason: null };
  let ghViewResult = null; // 单次 gh 查询缓存，strong 分支复用
  {
    const branch = receipt.branch;
    const prNumber = artifact.pr_number;
    if (prNumber == null) {
      binding.strength = 'weak';
      binding.reason = `artifact.pr_number 为 null（释放时无 PR），检查④不可执行，须 --allow-weak-binding`;
    }
    if (binding.strength === 'strong') {
      try {
        ghViewResult = ghPrView(receipt.canonical_repo, prNumber);
      } catch (e) {
        fail(`检查④ gh 查询失败（fail-closed）: ${e.message}`);
      }
      if (!ghViewResult.ok) {
        binding.strength = 'weak';
        binding.reason = `gh 不可用（${ghViewResult.reason}），检查④不可执行，须 --allow-weak-binding`;
      }
    }
    if (binding.strength === 'weak' && !allowWeak) {
      fail(`检查④ 不可执行（${binding.reason}）但未传 --allow-weak-binding：拒绝弱绑定（fail-closed）`);
    }
    if (binding.strength === 'strong') {
      const view = ghViewResult;
      const mismatches = [];
      if (view.headRefName !== branch) mismatches.push(`headRefName: gh=${view.headRefName} ≠ receipt.branch=${branch}`);
      const owner = receipt.canonical_repo.split('/')[0];
      if (view.headRepositoryOwner !== owner) mismatches.push(`headRepositoryOwner: gh=${view.headRepositoryOwner} ≠ canonical_repo owner=${owner}（v1 不支持 fork PR，F39 fail-closed）`);
      checks['4_repo_branch_binding'] = { ok: mismatches.length === 0, gh_headRefName: view.headRefName, gh_headRepositoryOwner: view.headRepositoryOwner, mismatches };
      if (mismatches.length) fail(`检查④ (canonical_repo, branch) 主关联不符: ${mismatches.join('; ')}`);
    } else {
      checks['4_repo_branch_binding'] = { ok: true, weak: true, reason: binding.reason };
    }
  }

  // ── 检查⑤：pr_number 等值（辅助键，仅两侧都非 null）──
  {
    if (receipt.pr_number != null && artifact.pr_number != null && receipt.pr_number !== artifact.pr_number) {
      checks['5_pr_number_equality'] = { ok: false, receipt: receipt.pr_number, artifact: artifact.pr_number };
      fail(`检查⑤ pr_number 等值不符: receipt=${receipt.pr_number} ≠ artifact=${artifact.pr_number}`);
    }
    checks['5_pr_number_equality'] = { ok: true, receipt: receipt.pr_number, artifact: artifact.pr_number };
  }

  // ── --expect-round：显式声明期望轮次 ──
  if (expectRound != null) {
    if (!Number.isInteger(expectRound) || expectRound <= 0) fail('--expect-round 必须为正整数');
    if (artifact.round !== expectRound) {
      checks['expect_round'] = { ok: false, expect: expectRound, actual: artifact.round };
      fail(`--expect-round=${expectRound} ≠ artifact.round=${artifact.round}（同 PR 跨轮需要显式声明轮次）`);
    }
    checks['expect_round'] = { ok: true, round: expectRound };
  }

  // ── base_sha 诊断（不阻断，rebase 后合法变化）──
  if (receipt.base_sha != null && artifact.base_sha != null && receipt.base_sha !== artifact.base_sha) {
    notes.push(`base_sha 诊断（不阻断）: receipt=${String(receipt.base_sha).slice(0, 12)} ≠ artifact=${String(artifact.base_sha).slice(0, 12)}——rebase 后合法变化，请在人工复核时确认`);
  }

  // ── 对账：只认 consensus artifact 的 canonical_findings；exact-key 匹配 ──
  // 预测集 = manifest.scs[].predicted_invariant 经同一 A.familyKeyOf 派生 + predicted_primary_face
  const predictedKeys = new Set();
  for (const sc of Array.isArray(manifest.scs) ? manifest.scs : []) {
    if (sc && typeof sc.predicted_invariant === 'string' && sc.predicted_invariant && sc.predicted_primary_face) {
      const fk = A.familyKeyOf(sc.predicted_invariant);
      if (fk) predictedKeys.add(`${fk}|${sc.predicted_primary_face}`);
    }
  }
  const findings = Array.isArray(artifact.canonical_findings) ? artifact.canonical_findings : [];
  const hits = [];
  const escapes = [];
  for (const f of findings) {
    if (!f || typeof f.invariant !== 'string' || !f.invariant || typeof f.primary_face !== 'string' || !f.primary_face) continue;
    const fk = A.familyKeyOf(f.invariant);
    if (!fk) continue;
    const key = `${fk}|${f.primary_face}`;
    if (predictedKeys.has(key)) {
      hits.push({ canonical_key: f.canonical_key, primary_face: f.primary_face, invariant: f.invariant });
    } else {
      escapes.push({ canonical_key: f.canonical_key, familyKey: fk, primary_face: f.primary_face, invariant: f.invariant });
    }
  }
  // 未命中项进人工复核段列全
  manualReview.push(...escapes.map((e) => ({
    kind: 'escape',
    canonical_key: e.canonical_key,
    family_key: e.familyKey,
    primary_face: e.primary_face,
    invariant: e.invariant,
  })));

  const ledger = escapes.length ? recordEscapes(escapes) : { added: 0, updated: 0, sync: null };

  const result = {
    ok: true,
    slug: manifest.slug,
    checks,
    binding: {
      strength: binding.strength,
      ...(binding.reason ? { reason: binding.reason } : {}),
    },
    reconciliation: {
      exact_key_only: true,
      exact_key_note: '机器层只做 exact-key 对账：同义改写措辞的逃逸会假阴（已知残余，靠人工复核段 + lead 扫视兜底），不声称语义对账',
      predicted: predictedKeys.size,
      actual: hits.length + escapes.length,
      hits: hits.length,
      escapes: escapes.length,
    },
    ledger,
    manual_review: manualReview,
    notes,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => fail(String(e?.message || e)));
