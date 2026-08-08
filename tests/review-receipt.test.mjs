// tests/review-receipt.test.mjs — P1-B Phase 4 对抗质询 receipt（单元 + CLI + 三支反向变异）。
//
// 背景（lead 2026-08-09 实测）：SKILL.md 只有 Phase 4 的 prompt 模板；final-gate 的 GATE_NAMES
// 里没有 adversarial 闸。跳过 Phase 4 直接填结构合法的 manifest → 七闸与 release 全过。
//
// 修复：Phase 4 产出可消费工件 review-receipt.json（scripts/lib/review-receipt.mjs 单一实现），
// final-gate 最终检查：存在性 + 草稿 hash 谱系关联（draftAncestorHash，lib/hashing.mjs）+
// gap-catalog 指纹现算比对。明确不做语义真伪（T1：防漏跑不防敷衍，敷衍兜底是三审）。
//
// 三支反向变异（判据 = 恰好红一条，另加对照组防「一律拒」）：
//   R1 缺 receipt            → REVIEW_RECEIPT_MISSING（唯一红）
//   R2 receipt 草稿 hash 旧   → REVIEW_RECEIPT_STALE（质询后改了草稿期字段未复审——
//                             变异选 priorities.title：不进投影区，保证红点只落在 review-receipt 闸）
//   R3 合法 receipt          → **对照组必须通过**
//
// ledger 指纹复用纪律：本测试用 ledger-query 同构的 `ledger-` + 10hex 形态；真实流程的指纹
// 由 lib/ledger-query.mjs 产出（Phase 1 已跑），本模块只消费其输出形状、不另写查询。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadAuthority } from '../scripts/lib/authority.mjs';
import { manifestCoreHash, draftAncestorHash, PLAN_RECEIPTS_MARKER } from '../scripts/lib/hashing.mjs';
import { renderPlanProjection } from '../scripts/lib/plan-projection.mjs';
import {
  REVIEW_RECEIPT_FILENAME,
  readShippedGapCatalog,
  gapCatalogFingerprint,
  isFingerprintShape,
  validateReviewReceipt,
} from '../scripts/lib/review-receipt.mjs';
import { buildWavesPlan } from '../scripts/waves-plan.mjs';
import { runFinalGate, MANIFEST_FILENAME, PLAN_FILENAME, GATE_NAMES } from '../scripts/final-gate.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'review-receipt';

// ─────────────────────────────────────────────────────────────────────────────
// 单元：validateReviewReceipt（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

function validReceipt(manifest, overrides = {}) {
  return {
    slug: manifest.slug,
    draft_manifest_core_hash: draftAncestorHash(manifest),
    gap_catalog_fingerprint: gapCatalogFingerprint(readShippedGapCatalog() ?? ''),
    ledger_fingerprint: 'ledger-0123456789',
    reviewer_count: 1,
    challenges: [{ challenge: 'B 面 n_a 是否敷衍', disposition: '无漏项' }],
    ...overrides,
  };
}

async function jointManifest() {
  const A = await loadAuthority();
  const m = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'tests', 'fixtures', 'joint', 'complete.json'), 'utf8'));
  return { A, m };
}

test('review-receipt 单元: 缺失 → MISSING；合法 → ok', async () => {
  const { m } = await jointManifest();
  const v1 = validateReviewReceipt(null, m, { gapCatalogText: readShippedGapCatalog() });
  assert.equal(v1.ok, false);
  assert.equal(v1.error_code, 'REVIEW_RECEIPT_MISSING');
  const v2 = validateReviewReceipt(validReceipt(m), m, { gapCatalogText: readShippedGapCatalog() });
  assert.equal(v2.ok, true, `合法 receipt 必须通过: ${JSON.stringify(v2)}`);
});

test('review-receipt 单元: 结构非法 → INVALID（逐字段）', async () => {
  const { m } = await jointManifest();
  const gapText = readShippedGapCatalog();
  const cases = [
    { name: '缺 slug', receipt: validReceipt(m, { slug: '' }) },
    { name: 'draft hash 非 64hex', receipt: validReceipt(m, { draft_manifest_core_hash: 'abc' }) },
    { name: 'gap_catalog_fingerprint 形状错', receipt: validReceipt(m, { gap_catalog_fingerprint: 'gap-catalog-zzz' }) },
    { name: 'ledger_fingerprint 形状错', receipt: validReceipt(m, { ledger_fingerprint: 'ledger-zz' }) },
    { name: 'reviewer_count = 0', receipt: validReceipt(m, { reviewer_count: 0 }) },
    { name: 'reviewer_count 非整数', receipt: validReceipt(m, { reviewer_count: '2' }) },
    { name: 'challenges 非数组', receipt: validReceipt(m, { challenges: {} }) },
    { name: 'challenge 缺 disposition', receipt: validReceipt(m, { challenges: [{ challenge: 'x' }] }) },
    { name: 'challenge 空串', receipt: validReceipt(m, { challenges: [{ challenge: '', disposition: '无漏项' }] }) },
  ];
  for (const c of cases) {
    const v = validateReviewReceipt(c.receipt, m, { gapCatalogText: gapText });
    assert.equal(v.ok, false, `${c.name} 必须拒`);
    assert.equal(v.error_code, 'REVIEW_RECEIPT_INVALID', `${c.name} 必须 INVALID，实际 ${v.error_code}`);
  }
});

test('review-receipt 单元: slug 不符 → SLUG_MISMATCH；gap-catalog 指纹不符 → GAP_CATALOG_MISMATCH', async () => {
  const { m } = await jointManifest();
  const v1 = validateReviewReceipt(validReceipt(m, { slug: '另一个-slug' }), m, { gapCatalogText: readShippedGapCatalog() });
  assert.equal(v1.ok, false);
  assert.equal(v1.error_code, 'REVIEW_RECEIPT_SLUG_MISMATCH');
  const v2 = validateReviewReceipt(validReceipt(m, { gap_catalog_fingerprint: 'gap-catalog-deadbeef00' }), m, { gapCatalogText: readShippedGapCatalog() });
  assert.equal(v2.ok, false);
  assert.equal(v2.error_code, 'REVIEW_RECEIPT_GAP_CATALOG_MISMATCH');
  // gap-catalog 文本缺省（读不到）→ fail-closed 同 MISMATCH
  const v3 = validateReviewReceipt(validReceipt(m), m, { gapCatalogText: null });
  assert.equal(v3.ok, false);
  assert.equal(v3.error_code, 'REVIEW_RECEIPT_GAP_CATALOG_MISMATCH');
});

test('review-receipt 单元: 质询后改草稿期字段（priorities.title）→ STALE', async () => {
  const { m } = await jointManifest();
  const receipt = validReceipt(m); // 质询时的合法 receipt
  const evolved = JSON.parse(JSON.stringify(m));
  evolved.priorities[0].title = '质询后改的标题（未复审）'; // 草稿期字段 → 祖先 hash 漂移
  const v = validateReviewReceipt(receipt, evolved, { gapCatalogText: readShippedGapCatalog() });
  assert.equal(v.ok, false);
  assert.equal(v.error_code, 'REVIEW_RECEIPT_STALE');
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI：scaffold（真实命令形态 = SKILL.md Phase 4 引用同一形态）
// ─────────────────────────────────────────────────────────────────────────────

test('review-receipt CLI: --draft-manifest + --ledger-fingerprint → 骨架 JSON（指纹内部现算）', async () => {
  const { m } = await jointManifest();
  // 草稿形状 = final 剔除 final 专属键（waves/dispatch/manifest_core_hash + scs[].preflight）
  const draft = { ...m };
  delete draft.waves;
  delete draft.dispatch;
  delete draft.manifest_core_hash;
  draft.scs = draft.scs.map((s) => {
    const { preflight, ...rest } = s;
    return rest;
  });
  const draftPath = path.join(mkdtempSync(path.join(tmpdir(), 'rr-draft-')), 'draft.json');
  writeFileSync(draftPath, JSON.stringify(draft), 'utf8');

  const r = spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, 'scripts', 'lib', 'review-receipt.mjs'),
      '--draft-manifest', draftPath, '--ledger-fingerprint', 'ledger-0123456789', '--reviewer-count', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `CLI 应 exit 0: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.slug, m.slug);
  assert.equal(out.draft_manifest_core_hash, manifestCoreHash(draft), 'draft hash 必须 == 草稿现算');
  assert.equal(out.draft_manifest_core_hash, draftAncestorHash(m), '谱系交叉一致性：草稿 hash == final 的草稿祖先 hash');
  assert.equal(out.gap_catalog_fingerprint, gapCatalogFingerprint(readShippedGapCatalog() ?? ''), 'gap-catalog 指纹内部现算');
  assert.equal(out.ledger_fingerprint, 'ledger-0123456789');
  assert.deepEqual(out.challenges, [], 'challenges 留空待 lead 补');
  assert.ok(out.reviewer_count === 1);

  // 非法 ledger 指纹 → exit 2（fail-closed，不许写盘）
  const bad = spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, 'scripts', 'lib', 'review-receipt.mjs'),
      '--draft-manifest', draftPath, '--ledger-fingerprint', '不是指纹'],
    { encoding: 'utf8' },
  );
  assert.equal(bad.status, 2, '非法 ledger 指纹必须 exit 2');
  rmSync(path.dirname(draftPath), { recursive: true, force: true });
});

test('review-receipt CLI: --out 原子写盘', async () => {
  const { m } = await jointManifest();
  const draft = { ...m };
  delete draft.waves;
  delete draft.dispatch;
  delete draft.manifest_core_hash;
  draft.scs = draft.scs.map((s) => {
    const { preflight, ...rest } = s;
    return rest;
  });
  const tmp = mkdtempSync(path.join(tmpdir(), 'rr-out-'));
  const draftPath = path.join(tmp, 'draft.json');
  const outPath = path.join(tmp, REVIEW_RECEIPT_FILENAME);
  writeFileSync(draftPath, JSON.stringify(draft), 'utf8');
  const r = spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, 'scripts', 'lib', 'review-receipt.mjs'),
      '--draft-manifest', draftPath, '--ledger-fingerprint', 'ledger-0123456789', '--out', outPath],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `CLI 应 exit 0: ${r.stderr}`);
  const onDisk = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(onDisk.draft_manifest_core_hash, manifestCoreHash(draft));
  assert.equal(isFingerprintShape(onDisk.gap_catalog_fingerprint, 'gap-catalog'), true);
  rmSync(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 三支反向变异（经 final-gate 最终检查；前置七闸 + 投影闸必须全 ok）
// ─────────────────────────────────────────────────────────────────────────────

function makeGoalDir() {
  return mkdtempSync(path.join(tmpdir(), 'rr-goal-'));
}

function makeRepoDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rr-repo-'));
  cpSync(path.join(SKILL_ROOT, 'tests', 'fixtures', 'preflight', 'repo-template'), dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=rr-test', '-c', 'user.email=test@test.local', 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=rr-test', '-c', 'user.email=test@test.local', 'commit', '-qm', 'init']);
  return dir;
}

function realPreflight(repoDir, sc) {
  const r = spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, 'scripts', 'sc-preflight.mjs'), '--repo', repoDir, '--cmd', sc.verify.cmd, ...sc.verify.args, '--sc-id', sc.id],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `sc-preflight 应 exit 0 for ${sc.id}: ${r.stderr}`);
  const receipt = JSON.parse(r.stdout.trim());
  delete receipt.worktree;
  return receipt;
}

async function buildCompleteManifest({ slug = SLUG, repoDir } = {}) {
  const A = await loadAuthority();
  const faces = A.FACES.map(String);
  const scs = [
    {
      id: 'SC-1', priority_id: 'P1', kind: 'fix', granularity: 'anchor',
      change: '把拖入画布的图片接入 AI 读取链路', holds: '拖入的图片可被 AI 读取',
      verify: { cmd: 'vitest', args: ['run', '-t', 'passing', 'src/pass.test.js'] }, expect: 'pass',
      anchor_paths: ['src/lib/util.ts', 'src/lib/foo.ts'], faces: [faces[0], faces[1], faces[2]],
      // 2026-08-09：gate/hardening 声明字段（P0-B 族闭环）——SC-1 承担前两个闸 + 全 10 类
      gates: [A.GATES[0], A.GATES[1]],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '拖入图片不被吞', predicted_primary_face: faces[0],
    },
    {
      id: 'SC-2', priority_id: 'P1', kind: 'verify', granularity: 'assertion',
      change: '验证图片读取链路端到端', holds: '链路结果稳定',
      verify: { cmd: 'npm', args: ['test'] }, expect: 'pass',
      anchor_paths: ['src/server/index.ts', 'src/server/other.ts'], faces: [faces[0], faces[2]],
      // 2026-08-09：SC-2 承担后两个闸（verify 只做部分闸验证）
      gates: [A.GATES[2], A.GATES[3]],
      hardening_classes: [],
    },
    {
      id: 'SC-3', priority_id: 'P2', kind: 'fix', granularity: 'anchor',
      change: '修复渲染器对图片资源的引用泄漏', holds: '渲染器资源引用释放',
      verify: { cmd: 'vitest', args: ['run', '-t', 'failing', 'src/fail.test.js'] }, expect: 'pass',
      anchor_paths: ['src/lib/bar.ts', 'src/server/baz.ts'], faces: [faces[1], faces[2], faces[3]],
      // 2026-08-09：P2 只有 SC-3 一条 SC → 全量声明（4 闸 + 全 10 类）
      gates: [...A.GATES],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '渲染器不泄漏', predicted_primary_face: faces[1],
    },
  ];
  scs[0].preflight = { ...realPreflight(repoDir, scs[0]), disposition: '接受（替身全绿，空转嫌疑由 lead 处置）' };
  scs[1].preflight = realPreflight(repoDir, scs[1]);
  scs[2].preflight = realPreflight(repoDir, scs[2]);
  const priorities = [
    { id: 'P1', title: '图片接入 AI 读取', why: 'owner 拍板优先级', pr_split: { suggested_prs: 2, functional_pr: true } },
    { id: 'P2', title: '渲染器资源泄漏修复', why: '渲染稳定性', pr_split: { suggested_prs: 1, functional_pr: false } },
  ];
  const dims = [
    ...faces.map((f) => ({ kind: 'face', dim: f })),
    ...A.GATES.map((g) => ({ kind: 'gate', dim: g })),
    ...A.HARDENING_CLASSES.map((h) => ({ kind: 'hardening', dim: String(h) })),
  ];
  const coverage = [];
  for (const task of priorities) {
    const taskScs = scs.filter((s) => s.priority_id === task.id);
    for (const { kind, dim } of dims) {
      if (kind === 'face' && dim === 'B') {
        coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'n_a', sc_ids: [],
          reason_code: 'no_ui_paths', evidence: 'fixture: 本 task anchor 全非 UI 路径，无 UI 面可判' });
      } else if (kind === 'face') {
        const declaring = taskScs.filter((s) => (s.faces ?? []).map(String).includes(dim));
        if (declaring.length > 0) {
          coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'covered', sc_ids: declaring.map((s) => s.id), evidence: 'e' });
        } else {
          coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'n_a', sc_ids: [], reason_code: 'no_claim_made', evidence: '本 task 无 SC 声明该面' });
        }
      } else {
        // 2026-08-09：gate/hardening covered 格必须由「声明了该维度」的 SC 支持（P0-B 族闭环，
        // CELL_GATE/HARDENING_NOT_DECLARED）；SC 声明并集覆盖全部 14 维度，无声明即抛（fail-fast）
        const field = kind === 'gate' ? 'gates' : 'hardening_classes';
        const declaring = taskScs.filter((s) => (s[field] ?? []).map(String).includes(String(dim)));
        if (declaring.length === 0) throw new Error(`task ${task.id} 无任一 SC 声明 ${kind} ${dim}（covered 格必须有声明支持）`);
        coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'covered', sc_ids: declaring.map((s) => s.id), evidence: 'e' });
      }
    }
  }
  const wavesResult = await buildWavesPlan({ scs, authority: A });
  const manifest = {
    schema_version: '1.0.0',
    slug,
    goal: 'review-receipt 测试齐全基线',
    context_refs: [],
    priorities,
    scs,
    coverage,
    waves: wavesResult.waves,
    dispatch: {
      capacity: wavesResult.capacity,
      packets: wavesResult.waves.flatMap((w) => w.groups).map((g) => ({
        group_id: g.group_id,
        scs_inline: g.sc_ids.map((sid) => scs.find((s) => s.id === sid)),
        allowed_paths: ['src/app', 'src/canvas', 'src/lib', 'src/render', 'src/server'],
        forbidden: ['node_modules', 'dist'],
        verify_cmds: ['node --test', 'npm test'],
        submit_format: '{status: PASS|BLOCKED, sc_results:[{sc_id, status, evidence}], changed_files, residual_risks}',
        instruction: '用 goal skill 执行本派工包，逐条 SC 拿到通过证据。',
        needs_three_review: true,
        manifest_core_hash: '',
      })),
    },
  };
  const coreHash = manifestCoreHash(manifest);
  manifest.manifest_core_hash = coreHash;
  for (const p of manifest.dispatch.packets) p.manifest_core_hash = coreHash;
  assert.equal(manifestCoreHash(manifest), coreHash, 'hash 回填后必须是不动点（黑名单剔除）');
  return manifest;
}

function rewriteHashes(m) {
  for (const p of m.dispatch.packets) {
    p.scs_inline = p.scs_inline.map((s) => m.scs.find((t) => t.id === s.id));
  }
  const h = manifestCoreHash(m);
  m.manifest_core_hash = h;
  for (const p of m.dispatch.packets) p.manifest_core_hash = h;
  assert.equal(manifestCoreHash(m), h, '变异后 hash 回填必须不动点');
  return m;
}

function writeManifest(goalDir, manifest) {
  writeFileSync(path.join(goalDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
}

function writePlan(goalDir, manifest) {
  const body = [
    `# task-priority 计划（${SLUG}）`,
    '',
    '## 目标',
    'review-receipt 测试 fixture 的 priority-plan.md 正文。',
    '',
    renderPlanProjection(manifest),
    '',
  ].join('\n');
  writeFileSync(path.join(goalDir, PLAN_FILENAME), body + PLAN_RECEIPTS_MARKER + '\n（receipts 区块）\n', 'utf8');
}

function writeReviewReceipt(goalDir, manifest, overrides = {}) {
  const receipt = {
    slug: manifest.slug,
    draft_manifest_core_hash: draftAncestorHash(manifest),
    gap_catalog_fingerprint: gapCatalogFingerprint(readShippedGapCatalog() ?? ''),
    ledger_fingerprint: 'ledger-0123456789',
    reviewer_count: 1,
    challenges: [{ challenge: 'B 面 n_a 是否敷衍', disposition: '无漏项' }],
    ...overrides,
  };
  writeFileSync(path.join(goalDir, REVIEW_RECEIPT_FILENAME), JSON.stringify(receipt, null, 2), 'utf8');
}

async function makeReadyRound({ withReceipt = true } = {}) {
  const goalDir = makeGoalDir();
  const repoDir = makeRepoDir();
  const manifest = await buildCompleteManifest({ repoDir });
  writeManifest(goalDir, manifest);
  writePlan(goalDir, manifest);
  if (withReceipt) writeReviewReceipt(goalDir, manifest);
  return { goalDir, repoDir, manifest };
}

/** review-receipt 红断言：前置七闸 + projection 全 ok，review-receipt 唯一红（目标码） */
function assertReviewOnlyRed(events, code) {
  const byGate = Object.fromEntries(events.map((e) => [e.gate, e]));
  for (const g of GATE_NAMES) {
    assert.equal(byGate[g].status, 'ok', `前置闸 ${g} 应 ok，实际 ${byGate[g].status}`);
  }
  assert.equal(byGate['projection'].status, 'ok', 'projection 闸必须 ok（红点不得落在投影闸）');
  assert.equal(byGate['review-receipt'].status, 'error', 'review-receipt 闸必须是红点');
  assert.equal(byGate['review-receipt'].error_code, code, `唯一红必须 ${code}，实际 ${byGate['review-receipt'].error_code}`);
}

test('R1: 缺 review-receipt → REVIEW_RECEIPT_MISSING（唯一红）', async () => {
  const { goalDir, repoDir } = await makeReadyRound({ withReceipt: false });
  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, false, '缺 receipt 必须 fail');
  assertReviewOnlyRed(r.events, 'REVIEW_RECEIPT_MISSING');
});

test('R2: receipt 草稿 hash 是旧的（质询后改 priorities.title 未复审）→ REVIEW_RECEIPT_STALE', async () => {
  const { goalDir, repoDir } = await makeReadyRound(); // receipt 按原始 manifest 写入
  const m = JSON.parse(readFileSync(path.join(goalDir, MANIFEST_FILENAME), 'utf8'));
  // 变异选 priorities.title：不进投影区（投影只渲染 SC/waves/n_a 格）→ 红点只能落在 review-receipt 闸
  m.priorities[0].title = '质询后新增的标题（未复审）';
  writeManifest(goalDir, rewriteHashes(m));

  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, false, '旧草稿 hash 必须拒');
  assertReviewOnlyRed(r.events, 'REVIEW_RECEIPT_STALE');
});

test('R3 对照组: 合法 receipt → 必须通过（闸不是「一律拒」）', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, true, `对照组必须通过: ${r.error ?? ''}`);
  assert.equal(r.events.length, GATE_NAMES.length + 2);
  for (const e of r.events) assert.equal(e.status, 'ok', `闸 ${e.gate} 应为 ok，实际 ${e.status}`);
});
