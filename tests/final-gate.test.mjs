// tests/final-gate.test.mjs — final-gate 定序回放 + 双 hash receipts + release-gate（SC-9 四支 + 补充支）。
//
// SC-9 四支：
//   1. 改 manifest 后旧 receipt 失效：先跑出 receipts，再改 manifest 任一字段 → release exit 2
//   2. 改 plan 正文后旧 receipt 失效：改 PLAN_RECEIPTS_MARKER **之前**的正文 → release exit 2
//      （对照：只改 marker **之后**的 receipts 区块 → plan_hash 不变 → 仍应通过）
//   3. 6c 后篡改 packet 再 release → 拒：写完 receipts 后篡改 dispatch.packets[0] 任一字段 → release exit 2
//   4. 前置闸红时后继闸记 not_run：造 manifest-validate 会红的产物 → coverage-matrix 记录是 not_run 而非 error
//
// 补充支：基线全绿 + receipts 不动点、release 无 receipts 拒、slug 身份绑定拒、authority 断路全 not_run。
//
// fixture 纪律（lead 坑 4）：不 hardlink 真实树；本文件全部产物写在 os.tmpdir() 一次性目录
// （测试自建临时 git 仓与临时 goal-dir），绝不写 ~/.claude/.goal、绝不碰任何 Project worktree。
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
} from '../scripts/lib/review-receipt.mjs';
import { buildWavesPlan } from '../scripts/waves-plan.mjs';
import {
  runFinalGate,
  runReleaseGate,
  MANIFEST_FILENAME,
  PLAN_FILENAME,
  RELEASE_RECEIPT_FILENAME,
  GATE_NAMES,
  FINAL_CHECK_GATES,
} from '../scripts/final-gate.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────────────────
// 测试基础设施：全部落在 os.tmpdir() 一次性目录（不写 ~/.claude、不碰 Project worktree）
// ─────────────────────────────────────────────────────────────────────────────

/** 临时 goal-dir（每个用例独立） */
function makeGoalDir() {
  return mkdtempSync(path.join(tmpdir(), 'final-gate-goal-'));
}

/** 临时 git 仓（canonicalRepo / branch 可解析；remote 指向真实 mivo 仓以便 registry 映射无关紧要）。
 *  P0#3（2026-08-09）：从 tests/fixtures/preflight/repo-template 拷贝（含 vitest/tsc 测试替身，
 *  node_modules 刻意提交进 HEAD），使 sc-preflight 能对真实 git 仓**实跑**产出执行凭据。 */
function makeRepoDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'final-gate-repo-'));
  cpSync(path.join(SKILL_ROOT, 'tests', 'fixtures', 'preflight', 'repo-template'), dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=final-gate-test', '-c', 'user.email=test@test.local', 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=final-gate-test', '-c', 'user.email=test@test.local', 'commit', '-qm', 'init']);
  return dir;
}

/**
 * 齐全 manifest 生成器（fixture 要点：维度集从 authority 动态取；B 维度 n_a 免 git 依赖；
 * waves 用 buildWavesPlan 真实重算值落盘；hash 先算后回填 = 不动点）。
 *
 * P0#3（2026-08-09）：preflight 必须是 sc-preflight 的**真实产物**（spawn 真实 CLI 对 repoDir
 * 实跑），不得手写。旧写法 `{status:'green_warn', note:'命令存在且实跑绿', disposition:'接受'}`
 * 是自报字符串——final-gate 现在逐 SC 比对 verify_fingerprint（与当前 verify 命令重算），
 * 手写产物没有 sc_id/verify_fingerprint，必然 PREFLIGHT_SC_ID_MISMATCH / FINGERPRINT_MISSING 拒。
 * disposition 是 lead 的处置字段（流程语义，不是执行凭据），在真实产物上附加。
 */
function realPreflight(repoDir, sc) {
  const r = spawnSync(
    process.execPath,
    [path.join(SKILL_ROOT, 'scripts', 'sc-preflight.mjs'), '--repo', repoDir, '--cmd', sc.verify.cmd, ...sc.verify.args, '--sc-id', sc.id],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `sc-preflight 应 exit 0 for ${sc.id}: ${r.stderr}`);
  const receipt = JSON.parse(r.stdout.trim());
  // worktree 是 sc-preflight 的隔离边界诊断字段（跑完已删），不落盘进 manifest 契约——
  // PREFLIGHT_KEYS 白名单刻意不含它（落盘字段集 = 执行凭据 + 五态状态），剥离后仍为真实产物
  delete receipt.worktree;
  return receipt;
}

async function buildCompleteManifest({ slug = 'final-complete', repoDir } = {}) {
  const A = await loadAuthority();
  const faces = A.FACES.map(String);
  // verify 命令必须是 repo-template 里替身可真实执行的（P0#3：preflight 要实跑）
  const scs = [
    {
      id: 'SC-1',
      priority_id: 'P1',
      kind: 'fix',
      granularity: 'anchor',
      change: '把拖入画布的图片接入 AI 读取链路',
      holds: '拖入的图片可被 AI 读取',
      verify: { cmd: 'vitest', args: ['run', '-t', 'passing', 'src/pass.test.js'] },
      expect: 'pass',
      // anchor 必须全部非 UI 命中（B 面 n_a 合法性的前提）——见 B cell 注释的历史教训
      anchor_paths: ['src/lib/util.ts', 'src/lib/foo.ts'],
      faces: [faces[0], faces[1], faces[2]],
      // 2026-08-09：gate/hardening 声明字段（P0-B 族闭环）——SC-1 承担前两个闸 + 全 10 类
      gates: [A.GATES[0], A.GATES[1]],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '拖入图片不被吞',
      predicted_primary_face: faces[0],
    },
    {
      id: 'SC-2',
      priority_id: 'P1',
      kind: 'verify',
      granularity: 'assertion',
      change: '验证图片读取链路端到端',
      holds: '链路结果稳定',
      verify: { cmd: 'npm', args: ['test'] },
      expect: 'pass',
      anchor_paths: ['src/server/index.ts', 'src/server/other.ts'],
      faces: [faces[0], faces[2]],
      // 2026-08-09：SC-2 承担后两个闸（verify 只做部分闸验证）
      gates: [A.GATES[2], A.GATES[3]],
      hardening_classes: [],
    },
    {
      id: 'SC-3',
      priority_id: 'P2',
      kind: 'fix',
      granularity: 'anchor',
      change: '修复渲染器对图片资源的引用泄漏',
      holds: '渲染器资源引用释放',
      verify: { cmd: 'vitest', args: ['run', '-t', 'failing', 'src/fail.test.js'] },
      expect: 'pass',
      anchor_paths: ['src/lib/bar.ts', 'src/server/baz.ts'],
      faces: [faces[1], faces[2], faces[3]],
      // 2026-08-09：P2 只有 SC-3 一条 SC → 全量声明（4 闸 + 全 10 类）
      gates: [...A.GATES],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '渲染器不泄漏',
      predicted_primary_face: faces[1],
    },
  ];
  // 真实 sc-preflight 产出执行凭据（SC-1 green_warn 附加 lead 处置；SC-2 exists_not_run；
  // SC-3 red_ok 均无需处置）
  const pf1 = realPreflight(repoDir, scs[0]);
  assert.equal(pf1.status, 'green_warn', `SC-1 替身实跑应 green_warn: ${JSON.stringify(pf1)}`);
  scs[0].preflight = { ...pf1, disposition: '接受（替身全绿，空转嫌疑由 lead 处置）' };
  const pf2 = realPreflight(repoDir, scs[1]);
  assert.equal(pf2.status, 'exists_not_run', `SC-2 npm 应 exists_not_run: ${JSON.stringify(pf2)}`);
  scs[1].preflight = pf2;
  const pf3 = realPreflight(repoDir, scs[2]);
  assert.equal(pf3.status, 'red_ok', `SC-3 替身实跑应 red_ok: ${JSON.stringify(pf3)}`);
  scs[2].preflight = pf3;
  const priorities = [
    { id: 'P1', title: '图片接入 AI 读取', why: 'owner 拍板优先级', pr_split: { suggested_prs: 2, functional_pr: true } },
    { id: 'P2', title: '渲染器资源泄漏修复', why: '渲染稳定性', pr_split: { suggested_prs: 1, functional_pr: false } },
  ];

  // 完整维度集（authority 动态：FACES + GATES + HARDENING_CLASSES 全量）
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
        // B 维度 n_a（免 git/registry 依赖）：anchor 必须全部非 UI 命中，no_ui_paths 才合法。
        // 历史教训：曾用 src/app/App.tsx / src/canvas/Canvas.tsx / src/render/useLeaferSpikeRenderer.ts
        // 作 anchor——三者都是真实 UI 命中（touches_ui=true，matched_paths 含之，2026-08-09 实测），
        // 却标 n_a，与 coverage-matrix 的「B 维度无论 status 都派生现跑 matcher」判据矛盾
        // （B_DIM_NA_CONTRADICTS_UI）。UI 面 anchor 的 task 必须走 covered + ui_prediction，
        // 不许用 n_a 绕过通道。
        coverage.push({
          task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'n_a',
          sc_ids: [], reason_code: 'no_ui_paths', evidence: 'fixture: 本 task anchor 全非 UI 路径，无 UI 面可判',
        });
      } else if (kind === 'face') {
        // P0-B（coverage-matrix 独占）：face covered 格必须由「声明了该面」的 SC 支持；
        // 无任一 SC 声明该面 → n_a(no_claim_made) 而非 covered——一条 SC 不得填满全矩阵。
        const declaring = taskScs.filter((s) => (s.faces ?? []).map(String).includes(dim));
        if (declaring.length > 0) {
          coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'covered', sc_ids: declaring.map((s) => s.id), evidence: 'e' });
        } else {
          coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'n_a', sc_ids: [], reason_code: 'no_claim_made', evidence: '本 task 无 SC 声明该面' });
        }
      } else {
        // 2026-08-09：gate/hardening covered 格必须由「声明了该维度」的 SC 支持（P0-B 族闭环，
        // CELL_GATE/HARDENING_NOT_DECLARED）；SC 声明并集覆盖全部 14 维度，无声明即抛（fail-fast，
        // 防未来声明漂移静默把 covered 格变成无绑定空格）
        const field = kind === 'gate' ? 'gates' : 'hardening_classes';
        const declaring = taskScs.filter((s) => (s[field] ?? []).map(String).includes(String(dim)));
        if (declaring.length === 0) throw new Error(`task ${task.id} 无任一 SC 声明 ${kind} ${dim}（covered 格必须有声明支持）`);
        coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'covered', sc_ids: declaring.map((s) => s.id), evidence: 'e' });
      }
    }
  }

  // waves 用真实重算值落盘（final-gate 的 waves 一致性闸要求落盘 == 重算）
  const wavesResult = await buildWavesPlan({ scs, authority: A });

  // 先算 hash 再回填（黑名单排除 manifest_core_hash → 不动点）
  const manifest = {
    schema_version: '1.0.0',
    slug,
    goal: 'final-gate 测试齐全基线',
    context_refs: [],
    priorities,
    scs,
    coverage,
    waves: wavesResult.waves,
    dispatch: {
      capacity: wavesResult.capacity,
      // 按重算 waves 逐组建 packet（每组恰好一个）：dispatch 的投递面必须与 waves 的
      // 计划面精确对账（dispatch-completeness 判据 c1/c2/c3/c4）。历史教训：曾用「单个
      // packet 装全部 SC」——waves 重算是 3 组而投递只有 1 组，即 P0「SC 被找到却永不执行」，
      // 该缺陷形态本身就是本次修复的目标（lead 2026-08-09 实测确认）。
      packets: wavesResult.waves.flatMap((w) => w.groups).map((g) => ({
        group_id: g.group_id,
        scs_inline: g.sc_ids.map((sid) => scs.find((s) => s.id === sid)), // 与顶层 scs 同引用，逐字一致
        allowed_paths: ['src/app', 'src/canvas', 'src/lib', 'src/render', 'src/server'],
        forbidden: ['node_modules', 'dist'],
        verify_cmds: ['node --test', 'npm test'],
        submit_format: '{status: PASS|BLOCKED, sc_results:[{sc_id, status, evidence}], changed_files, residual_risks}',
        instruction: '用 goal skill 执行本派工包，逐条 SC 拿到通过证据。',
        needs_three_review: true,
        manifest_core_hash: '', // 占位，下面回填
      })),
    },
  };
  const coreHash = manifestCoreHash(manifest);
  manifest.manifest_core_hash = coreHash;
  for (const p of manifest.dispatch.packets) p.manifest_core_hash = coreHash;
  assert.equal(manifestCoreHash(manifest), coreHash, 'hash 回填后必须是不动点（黑名单剔除）');
  return manifest;
}

/**
 * priority-plan.md：自由散文正文 + 机器投影区（marker 包夹，P1-A） + receipts 区块（marker 界定）。
 * 投影区必须由 renderPlanProjection 从**落盘的同一 manifest** 渲染——final-gate 的投影闸
 * 逐字节比对「plan 内 marker 区块 == manifest 现渲染」，手写/旧渲染都会红。
 */
function writePlan(goalDir, slug, manifest, { receiptsBlock = true } = {}) {
  const body = [
    `# task-priority 计划（${slug}）`,
    '',
    '## 目标',
    'final-gate 测试 fixture 的 priority-plan.md 正文。',
    '',
    '## SC 清单',
    '| id | 内容 |',
    '|----|------|',
    '| SC-1 | 接入图片 AI 读取 |',
    '| SC-2 | 验证链路 |',
    '| SC-3 | 修复渲染泄漏 |',
    '',
    renderPlanProjection(manifest), // 机器投影区：manifest 确定性渲染，双产物语义绑定
    '',
  ].join('\n');
  const receipts = [
    PLAN_RECEIPTS_MARKER,
    '',
    '| slug | manifest_core_hash | plan_hash | recorded_at |',
    '|------|--------------------|-----------|-------------|',
    `| ${slug} | （release 前由流程渲染） | （同上） | — |`,
    '',
  ].join('\n');
  writeFileSync(path.join(goalDir, PLAN_FILENAME), body + (receiptsBlock ? receipts : ''), 'utf8');
  return body; // 返回正文（不含 marker 后区块），供测试篡改
}

/**
 * review-receipt.json（P1-B）：Phase 4 对抗质询工件。draft hash 用 draftAncestorHash 从
 * 当前 manifest 还原草稿祖先（谱系键），gap_catalog_fingerprint 用 shipped 文件现算——
 * 与 final-gate 的判据同源，测试里手写一个错误值就是在造「漂移」变异。
 */
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

function writeManifest(goalDir, manifest) {
  writeFileSync(path.join(goalDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
}

function readManifest(goalDir) {
  return JSON.parse(readFileSync(path.join(goalDir, MANIFEST_FILENAME), 'utf8'));
}

/** 标准场景：临时 goal + 临时 repo + 齐全 manifest + plan（含投影区）+ review-receipt → 返回 {goalDir, repoDir, manifest, body} */
async function makeReadyRound({ slug = 'final-complete' } = {}) {
  const goalDir = makeGoalDir();
  const repoDir = makeRepoDir();
  const manifest = await buildCompleteManifest({ slug, repoDir });
  writeManifest(goalDir, manifest);
  const body = writePlan(goalDir, slug, manifest);
  writeReviewReceipt(goalDir, manifest);
  return { goalDir, repoDir, manifest, body };
}

const FIXED_NOW = '2026-08-08T15:30:00.000Z';

// ─────────────────────────────────────────────────────────────────────────────
// 补充支 0：基线全绿 + receipts 不动点
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate: 基线全绿 → 七闸 + 两最终检查（投影/review-receipt）全 ok、receipts 写入且不动点', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const r = await runFinalGate({ slug: 'final-complete', goalDir, repoDir, now: new Date(FIXED_NOW) });
  assert.equal(r.ok, true, `基线应全绿: ${r.error ?? ''}`);
  assert.equal(r.events.length, GATE_NAMES.length + FINAL_CHECK_GATES.length);
  for (const e of r.events) {
    assert.equal(e.status, 'ok', `闸 ${e.gate} 应为 ok，实际 ${e.status}`);
    assert.equal(e.error_code, null);
  }
  // receipts 已写进 manifest，且 hash 与重算一致（不动点：receipts 是黑名单排除键）
  const onDisk = readManifest(goalDir);
  assert.ok(Array.isArray(onDisk.receipts) && onDisk.receipts.length === 1);
  const rec = onDisk.receipts[0];
  assert.equal(rec.slug, 'final-complete');
  assert.equal(rec.manifest_core_hash, r.manifest_core_hash);
  assert.equal(rec.plan_hash, r.plan_hash);
  assert.equal(rec.recorded_at, FIXED_NOW);
  assert.equal(manifestCoreHash(onDisk), r.manifest_core_hash, 'receipts 写入后 core hash 必须不变');
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-9 支 1：改 manifest 后旧 receipt 失效
// ─────────────────────────────────────────────────────────────────────────────
test('SC-9 #1: 改 manifest 后旧 receipt 失效 → release exit 2', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const f = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(f.ok, true, `基线应全绿: ${f.error ?? ''}`);

  // 篡改 manifest 任一字段（goal 进 core hash）
  const m = readManifest(goalDir);
  m.goal = '被篡改的目标';
  writeManifest(goalDir, m);

  const rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, false, 'manifest 被改后 release 必须拒');
  assert.ok(rel.mismatches && rel.mismatches.some((x) => x.includes('manifest_core_hash')), `应点名 manifest_core_hash 漂移: ${JSON.stringify(rel.mismatches)}`);
  assert.match(rel.error ?? '', /回 Phase 2\/5 重走/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-9 支 2：改 plan 正文后旧 receipt 失效；对照：只改 marker 后区块仍应通过
// ─────────────────────────────────────────────────────────────────────────────
test('SC-9 #2: 改 plan 正文（marker 前）后旧 receipt 失效；只改 marker 后 receipts 区块仍通过', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const f = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(f.ok, true, `基线应全绿: ${f.error ?? ''}`);
  const planPath = path.join(goalDir, PLAN_FILENAME);

  // ① 改 marker 之前的正文 → plan_hash 变 → release 拒
  let plan = readFileSync(planPath, 'utf8');
  const idx = plan.indexOf(PLAN_RECEIPTS_MARKER);
  assert.ok(idx > 0, 'plan 必须含 marker');
  plan = plan.slice(0, idx) + '<!-- 正文被篡改 -->\n' + plan.slice(idx);
  writeFileSync(planPath, plan, 'utf8');
  let rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, false, 'plan 正文被改后 release 必须拒');
  assert.ok(rel.mismatches && rel.mismatches.some((x) => x.includes('plan_hash')), `应点名 plan_hash 漂移: ${JSON.stringify(rel.mismatches)}`);

  // ② 对照：恢复正文，只改 marker 之后的 receipts 区块 → plan_hash 不变 → 仍应通过
  writeFileSync(planPath, plan.slice(0, idx) + plan.slice(plan.indexOf('<!-- 正文被篡改 -->\n') + '<!-- 正文被篡改 -->\n'.length), 'utf8');
  plan = readFileSync(planPath, 'utf8');
  assert.ok(!plan.includes('正文被篡改'), '对照前先恢复正文');
  const afterMarker = plan.slice(plan.indexOf(PLAN_RECEIPTS_MARKER));
  const tamperedAfter = afterMarker.replace('（release 前由流程渲染）', '已被篡改但不应影响 plan_hash');
  writeFileSync(planPath, plan.slice(0, plan.indexOf(PLAN_RECEIPTS_MARKER)) + tamperedAfter, 'utf8');
  rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, true, `只改 marker 后 receipts 区块应仍通过: ${rel.error ?? ''}`);
  assert.ok(rel.releaseReceipt, '通过后必须产出 release-receipt');
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-9 支 3：6c 后篡改 packet 再 release → 拒
// ─────────────────────────────────────────────────────────────────────────────
test('SC-9 #3: 6c 后篡改 dispatch.packets[0] 再 release → 拒', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const f = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(f.ok, true, `基线应全绿: ${f.error ?? ''}`);

  const m = readManifest(goalDir);
  m.dispatch.packets[0].submit_format = '被篡改的提交格式';
  writeManifest(goalDir, m);

  const rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, false, 'packet 被篡改后 release 必须拒');
  assert.ok(rel.mismatches && rel.mismatches.some((x) => x.includes('manifest_core_hash')), `packet 篡改必须体现为 core hash 漂移: ${JSON.stringify(rel.mismatches)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC-9 支 4：前置闸红时后继闸记 not_run（不是第二个红）
// ─────────────────────────────────────────────────────────────────────────────
test('SC-9 #4: manifest-validate 红 → coverage-matrix 记 not_run 而非 error', async () => {
  const { goalDir, repoDir } = await makeReadyRound();

  // 造 manifest-validate 会红的产物：删一个 SC 的 change（三段式不完整），
  // 重算 hash 回填 → hashes 闸仍过，红点落在 manifest-validate 上
  const m = readManifest(goalDir);
  delete m.scs[0].change;
  const badHash = manifestCoreHash(m);
  m.manifest_core_hash = badHash;
  m.dispatch.packets[0].manifest_core_hash = badHash;
  writeManifest(goalDir, m);

  const r = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(r.ok, false, '结构红的产物必须 fail');
  const byGate = Object.fromEntries(r.events.map((e) => [e.gate, e]));
  assert.equal(byGate['hashes'].status, 'ok', 'hash 已重算回填，hashes 闸应过');
  assert.equal(byGate['manifest-validate'].status, 'error', 'manifest-validate 必须是红点');
  assert.ok(byGate['manifest-validate'].error_code, 'error 必须带 error_code');
  assert.equal(byGate['coverage-matrix'].status, 'not_run', '前置闸红 → coverage-matrix 必须 not_run，不是第二个红');
  assert.equal(byGate['waves'].status, 'not_run');
  assert.equal(byGate['preflight'].status, 'not_run');
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充支：release 无 receipts → 拒
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate: release 时无 receipts → 拒', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, false);
  assert.match(rel.error ?? '', /无 receipts/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充支：slug 身份绑定 —— manifest.slug ≠ 目标 → 拒（release 与 final 两路径）
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate: manifest.slug ≠ 目标 slug → final 拒（SLUG_MISMATCH）且 release 拒', async () => {
  const { goalDir, repoDir } = await makeReadyRound({ slug: 'final-complete' });
  const m = readManifest(goalDir);
  m.slug = '另一个-slug'; // slug 进 core hash，hash 也随之漂移——两者都是身份绑定失败
  writeManifest(goalDir, m);

  const f = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(f.ok, false);
  assert.equal(Object.fromEntries(f.events.map((e) => [e.gate, e]))['hashes'].status, 'error');
  assert.ok(Object.fromEntries(f.events.map((e) => [e.gate, e]))['hashes'].error_code, 'hashes 闸必须带 error_code');

  const rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(rel.ok, false, 'slug 不符的产物 release 必须拒');
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充支：authority 断路 → AUTHORITY_UNREACHABLE 且后继闸全 not_run
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate: authority 断路 → AUTHORITY_UNREACHABLE 且后面全 not_run', async () => {
  const { goalDir } = await makeReadyRound();
  const r = await runFinalGate({
    slug: 'final-complete',
    goalDir,
    configPath: '/nonexistent/final-gate-config.json',
  });
  assert.equal(r.ok, false);
  const byGate = Object.fromEntries(r.events.map((e) => [e.gate, e]));
  assert.equal(byGate['authority'].status, 'error');
  assert.equal(byGate['authority'].error_code, 'AUTHORITY_UNREACHABLE');
  for (const g of GATE_NAMES.slice(1)) {
    assert.equal(byGate[g].status, 'not_run', `authority 断路后 ${g} 必须 not_run`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充支：CLI 冒烟 —— 成功路径输出 LIVE_ROUND_OK；失败路径 exit 2 且逐闸事件
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate CLI: 全绿输出 LIVE_ROUND_OK；release 漂移 exit 2', () => {
  const goalDir = makeGoalDir();
  const repoDir = makeRepoDir();
  const runCli = (args) =>
    spawnSync(process.execPath, [path.join(SKILL_ROOT, 'scripts', 'final-gate.mjs'), ...args], {
      encoding: 'utf8',
    });

  // 异步准备产物
  return (async () => {
    const manifest = await buildCompleteManifest({ slug: 'cli-smoke', repoDir });
    writeManifest(goalDir, manifest);
    writePlan(goalDir, 'cli-smoke', manifest);
    writeReviewReceipt(goalDir, manifest);

    const ok = runCli(['--slug', 'cli-smoke', '--goal-dir', goalDir, '--repo-dir', repoDir]);
    assert.equal(ok.status, 0, `CLI 全绿应 exit 0: ${ok.stderr}`);
    assert.match(ok.stdout, /LIVE_ROUND_OK/);
    assert.match(ok.stdout, /"gate": "coverage-matrix"/);

    // release 前篡改 → exit 2
    const m = readManifest(goalDir);
    m.goal = 'CLI 冒烟篡改';
    writeManifest(goalDir, m);
    const bad = runCli(['--slug', 'cli-smoke', '--goal-dir', goalDir, '--repo-dir', repoDir, '--release']);
    assert.equal(bad.status, 2, 'release 漂移应 exit 2');
    assert.match(bad.stderr, /RELEASE_FAIL/);
    assert.match(bad.stderr, /manifest_core_hash/);
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充支：release 通过后写 release-receipt.json（canonical_repo/branch/pr_number/binding_strength/base_sha）
// ─────────────────────────────────────────────────────────────────────────────
test('final-gate: release 通过 → release-receipt.json 落盘含 v7 字段', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const f = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(f.ok, true);

  const rel = await runReleaseGate({ slug: 'final-complete', goalDir, repoDir, now: new Date(FIXED_NOW) });
  assert.equal(rel.ok, true, `release 应通过: ${rel.error ?? ''}`);
  assert.ok(Array.isArray(rel.packets) && rel.packets.length >= 1, '必须输出已验证快照的 packet');

  const rr = JSON.parse(readFileSync(path.join(goalDir, RELEASE_RECEIPT_FILENAME), 'utf8'));
  assert.equal(rr.slug, 'final-complete');
  assert.equal(rr.manifest_core_hash, f.manifest_core_hash);
  assert.equal(rr.plan_hash, f.plan_hash);
  assert.equal(rr.canonical_repo, 'xindong/mivo-canvas'); // 离线派生（git remote → owner/name）
  assert.ok(typeof rr.branch === 'string' && rr.branch.length > 0);
  assert.equal(rr.pr_number, null); // 临时仓无 draft PR → null
  assert.equal(rr.binding_strength, 'weak'); // pr_number 为 null → weak（报告须标注）
  assert.ok(typeof rr.base_sha === 'string' && rr.base_sha.length > 0, 'base_sha 仅诊断，必须落盘');
  assert.equal(rr.released_at, FIXED_NOW);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0#3 反向变异（2026-08-09）：preflight 执行凭据绑定
// 判据：缺 receipt / sc_id 不符 / 指纹缺失 / 指纹不匹配均拒；真实 sc-preflight 产物（对照组）
// 必须通过——对照组就是「基线全绿」测试本身，此处只测红路径三支。
// 注意：sc.preflight 结构缺失会先在 manifest-validate 红（PREFLIGHT_MISSING，final 必备），
// final-gate 层可测的「缺 receipt」= 存在 preflight 但缺执行凭据（旧手写格式）。
// ─────────────────────────────────────────────────────────────────────────────

/** 变异后同步 dispatch.packets 的 scs_inline（与顶层 scs 逐字一致）+ 重算 hash 回填（不动点） */
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

/** 前置五闸（到 waves 为止）必须全 ok —— 红点只能落在 preflight 闸 */
function assertPreflightOnlyRed(events, code) {
  const byGate = Object.fromEntries(events.map((e) => [e.gate, e]));
  for (const g of ['authority', 'load', 'hashes', 'manifest-validate', 'coverage-matrix', 'waves']) {
    assert.equal(byGate[g].status, 'ok', `[P0#3] 前置闸 ${g} 应 ok，实际 ${byGate[g].status}`);
  }
  assert.equal(byGate['preflight'].status, 'error', '[P0#3] preflight 闸必须是红点');
  assert.equal(byGate['preflight'].error_code, code, `[P0#3] 唯一红必须 ${code}，实际 ${byGate['preflight'].error_code}`);
}

test('P0#3 #1: 手写 status（旧格式，无 sc_id/verify_fingerprint）→ PREFLIGHT_SC_ID_MISMATCH', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  // 旧基线写法：{status, note, disposition}——这就是 P0#3 缺陷的原形态（自报字符串）。
  // final-gate 现在要求 sc_id 绑定被验对象，手写产物无凭据 → 拒。
  const m = readManifest(goalDir);
  m.scs[0].preflight = { status: 'green_warn', note: '命令存在且实跑绿', disposition: '接受' };
  writeManifest(goalDir, rewriteHashes(m));
  const r = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(r.ok, false);
  assertPreflightOnlyRed(r.events, 'PREFLIGHT_SC_ID_MISMATCH');
});

test('P0#3 #2: 改 SC 的 verify 命令后旧 receipt 指纹不匹配 → PREFLIGHT_FINGERPRINT_MISMATCH', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  // verify 从 vitest 换成 tsc（命令已变更），但 receipt 还是旧命令的指纹 → 证据过期，拒
  const m = readManifest(goalDir);
  m.scs[0].verify = { cmd: 'tsc', args: ['--noEmit'] };
  writeManifest(goalDir, rewriteHashes(m));
  const r = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(r.ok, false);
  assertPreflightOnlyRed(r.events, 'PREFLIGHT_FINGERPRINT_MISMATCH');
});

test('P0#3 #3: 有 sc_id 但缺 verify_fingerprint → PREFLIGHT_FINGERPRINT_MISSING', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const m = readManifest(goalDir);
  // 只保留 sc_id（声称验过这个 SC）但删掉指纹——执行凭据不全，不得当「已空跑」
  const { sc_id, status, note, disposition } = m.scs[0].preflight;
  m.scs[0].preflight = { sc_id, status, note, disposition };
  writeManifest(goalDir, rewriteHashes(m));
  const r = await runFinalGate({ slug: 'final-complete', goalDir, repoDir });
  assert.equal(r.ok, false);
  assertPreflightOnlyRed(r.events, 'PREFLIGHT_FINGERPRINT_MISSING');
});

// 对照组：真实 sc-preflight 产物 + 合法 disposition 必须通过——由「基线全绿」测试覆盖
// （buildCompleteManifest 用真实 CLI 产出 receipt，七闸 + 两最终检查全 ok）。
