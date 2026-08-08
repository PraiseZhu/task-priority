// tests/dispatch-binding.test.mjs — P0 修复：dispatch↔waves↔顶层SC 三向绑定反向变异族。
//
// 背景（lead 2026-08-08 实测复现）：SC 被前置工序正确找到、waves 计划也包含它，但投递边界
// （dispatch.packets）可以静默丢弃它——manifest-validate 只要求 packet 内联 SC 是顶层子集、
// packet.group_id 只查非空，最终 final-gate 七闸全过、release 放行，SC 永不执行。
// 修复把判据所有权定在 manifest-validate 的 dispatch-completeness 子判据（核心机制 C）：
//   c1  组集合 ==（缺组/多组/波浪侧重复都拒）→ DISPATCH_GROUP_SET_MISMATCH
//   c2  每组合数 == 1 → DISPATCH_GROUP_PACKET_COUNT
//   c4  全部 inline 合并 == 顶层 scs 且各恰一次 → DISPATCH_SC_COVERAGE_INCOMPLETE（先于 c3，lead 裁决：
//       「恰出现一次」是 c4 的专属条款，先查它才能让「重复投递」命中 c4 而非被 c3 抢先）
//   c3  逐组 inline 集合 == 该组 waves sc_ids → DISPATCH_GROUP_SC_MISMATCH
// fail-fast（c1→c2→c4→c3，第一个被破坏的不变量先报）保证每支变异恰好一个目标错误码；
// final-gate 只消费 manifest-validate 的结果不重判——本测试断言后继闸记 not_run（不是第二个红）。
//
// 基线：自洽完整 manifest（重算 waves + 按重算 waves 逐组建 packet + hash 不动点回填），
// 跑 final 七闸 + release 双绿（证明新判据不拒死合法输入）。五支变异从基线深拷贝**只改一处**；
// 每支重算 waves（变异不动顶层 scs → 重算结果必须与基线 waves 相等，断言防未来漂移）与 hash 回填。
//
// 权威模式同 reverse-mutation.test.mjs：每支变异前显式写下目标错误码，实跑后逐闸对照；
// 红集与预测不符 → 停下修闸或修预测并说清理由，不调基线迁就。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadAuthority } from '../scripts/lib/authority.mjs';
import { manifestCoreHash, draftAncestorHash, PLAN_RECEIPTS_MARKER } from '../scripts/lib/hashing.mjs';
import { renderPlanProjection } from '../scripts/lib/plan-projection.mjs';
import { REVIEW_RECEIPT_FILENAME, readShippedGapCatalog, gapCatalogFingerprint } from '../scripts/lib/review-receipt.mjs';
import { buildWavesPlan } from '../scripts/waves-plan.mjs';
import {
  runFinalGate,
  runReleaseGate,
  MANIFEST_FILENAME,
  PLAN_FILENAME,
  GATE_NAMES,
  FINAL_CHECK_GATES,
} from '../scripts/final-gate.mjs';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'dispatch-binding';

let A;          // 真实 authority（before 里 await）
let repoDir;    // 临时 git repo（coverage-matrix 的 --cwd，canonical = xindong/mivo-canvas）
let baseline;   // 自洽完整基线 manifest（内存对象，无共享文件）
let baselineWaves;
let goalDirSeq = 0;

function makeGoalDir() {
  return mkdtempSync(join(tmpdir(), `dispatch-binding-goal-${goalDirSeq += 1}-`));
}

function writeManifest(goalDir, manifest) {
  writeFileSync(join(goalDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
}

// P1-A/P1-B（2026-08-09）：本文件的手写简易 plan（无投影区）与「无 review-receipt 的回合」
// 是**第五处**被新 final 契约抓到的旧基线。前四处同形态（测试作者为省依赖/图方便写出缺陷形态
// 并固化成基线，2026-08-09 lead 复盘）：
//   1. tests/final-gate.test.mjs —— B 面写 n_a/no_ui_paths 而 anchor 含真实 UI 命中路径
//   2. tests/coverage-matrix.test.mjs —— cell() 默认给全部 21 格填 SC-1，而 SC-1 只声明 faces=[A,B,C]
//   3. tests/fixtures/joint/complete.json —— 8 个 face 格引用未声明该面的 SC（生成器 :58 全填 taskScs）
//   4. 本文件自身 —— 手写 `{status, note, disposition}` preflight 自报字符串（P0#3 已改为真实产物）
// 本处（第五处）：plan 是「正文 + 空 receipts 区块」的简易文本，既无机器投影区（P1-A 投影闸必红
// PLAN_PROJECTION_MISSING），回合也没有 review-receipt.json（P1-B 闸必红 REVIEW_RECEIPT_MISSING）。
// 修法同前四处：基线升级为新契约的合法形态（投影区由 renderPlanProjection 渲染 + 合法 receipt），
// 而不是为新闸开豁免——新闸是修复对象，基线必须学会说真话。

/** priority-plan.md：自由散文 + 机器投影区（renderPlanProjection 渲染，P1-A）+ receipts 区块 */
function writePlan(goalDir, manifest) {
  const body = [
    `# task-priority 计划（${SLUG}）`, '',
    '## SC 清单',
    '| id | 内容 |',
    '|----|------|',
    '| SC-1 | 接入 AI 读取 |',
    '| SC-2 | 验证链路 |',
    '| SC-3 | 修渲染泄漏 |',
    '',
    renderPlanProjection(manifest), // 机器投影区：manifest 确定性渲染，双产物语义绑定
    '',
  ].join('\n');
  writeFileSync(join(goalDir, PLAN_FILENAME), body + PLAN_RECEIPTS_MARKER + '\n（receipts 区块）\n', 'utf8');
}

/**
 * review-receipt.json（P1-B）：draft hash 用 draftAncestorHash 从当前 manifest 还原草稿祖先，
 * gap_catalog_fingerprint 用 shipped 文件现算——与 final-gate 判据同源。
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
  writeFileSync(join(goalDir, REVIEW_RECEIPT_FILENAME), JSON.stringify(receipt, null, 2), 'utf8');
}

before(async () => {
  A = await loadAuthority();
  assert.deepEqual(A.FACES, ['A', 'B', 'C', 'D', 'E', 'F', 'G'], '测试前提：FACES = A..G');
  repoDir = mkdtempSync(join(tmpdir(), 'dispatch-binding-repo-'));
  // P0#3（2026-08-09）：从 tests/fixtures/preflight/repo-template 拷贝（含 vitest/tsc 测试替身，
  // node_modules 刻意提交进 HEAD），使 sc-preflight 能对真实 git 仓**实跑**产出执行凭据
  cpSync(join(SKILL_ROOT, 'tests', 'fixtures', 'preflight', 'repo-template'), repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', repoDir]);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  execFileSync('git', ['-C', repoDir, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=dispatch-binding-test', '-c', 'user.email=test@test.local', 'add', '-A']);
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=dispatch-binding-test', '-c', 'user.email=test@test.local', 'commit', '-qm', 'init']);
  baseline = await buildBaselineManifest();
  baselineWaves = baseline.waves;
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ── 基线：2 组（g1=[SC-1,SC-3] fix 同组、v1=[SC-2] verify），全非 UI anchor，逐组 packets ──
// anchor 选择依据（2026-08-09 实测）：src/app/*、src/canvas/*、src/render/* 命中 UI registry
// （touches_ui=true）；src/lib/*、src/server/* 不命中 → B 面 n_a(no_ui_paths) 合法。
//
// P0#3（2026-08-09）：本文件的 preflight 手写旧格式是**第四处**被新 final 契约抓到的旧基线。
// 前三处同形态（测试作者为省依赖/图方便写出缺陷形态并固化成基线，2026-08-09 lead 复盘）：
//   1. tests/final-gate.test.mjs —— B 面写 n_a/no_ui_paths 而 anchor 含真实 UI 命中路径
//   2. tests/coverage-matrix.test.mjs —— cell() 默认给全部 21 格填 SC-1，而 SC-1 只声明 faces=[A,B,C]
//   3. tests/fixtures/joint/complete.json —— 8 个 face 格引用未声明该面的 SC（生成器 :58 全填 taskScs）
// 本处（第四处）：手写 `{status, note, disposition}` 自报字符串，无执行凭据（sc_id/verify_fingerprint）。
// P0#3 后 final-gate 逐 SC 比对 verify_fingerprint，手写产物必然 PREFLIGHT_SC_ID_MISMATCH 拒——
// 所以这里改为真实 sc-preflight 产物（spawn 真实 CLI 对 repoDir 实跑，同 final-gate.test.mjs 做法）。
async function buildBaselineManifest() {
  // 真实 sc-preflight 产物：SC-1/SC-3 对 repo-template 实跑 green_warn（附加 lead 处置），
  // SC-2 npm ∈ existsOnly → exists_not_run（无需处置）。worktree 是隔离边界诊断字段不落盘。
  const realPreflight = (cmd, args, scId) => {
    const r = spawnSync(
      process.execPath,
      [join(SKILL_ROOT, 'scripts', 'sc-preflight.mjs'), '--repo', repoDir, '--cmd', cmd, ...args, '--sc-id', scId],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `sc-preflight 应 exit 0 for ${scId}: ${r.stderr}`);
    const rec = JSON.parse(r.stdout.trim());
    delete rec.worktree;
    return rec;
  };
  const scs = [
    {
      id: 'SC-1', priority_id: 'P1', kind: 'fix', granularity: 'anchor',
      change: '接入 AI 读取', holds: '可读不被吞',
      verify: { cmd: 'vitest', args: ['run', '-t', 'passing', 'src/pass.test.js'] }, expect: 'pass',
      anchor_paths: ['src/lib/util.ts', 'src/lib/foo.ts'], faces: ['A', 'B', 'C'],
      // 2026-08-09：gate/hardening 声明字段（P0-B 族闭环）——SC-1 承担前两个闸 + 全 10 类
      gates: [A.GATES[0], A.GATES[1]],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '不被吞', predicted_primary_face: 'B',
      preflight: { ...realPreflight('vitest', ['run', '-t', 'passing', 'src/pass.test.js'], 'SC-1'), disposition: '接受（替身全绿，空转嫌疑由 lead 处置）' },
    },
    {
      id: 'SC-2', priority_id: 'P1', kind: 'verify', granularity: 'assertion',
      change: '验证链路', holds: '链路稳定',
      verify: { cmd: 'npm', args: ['test'] }, expect: 'pass',
      anchor_paths: ['src/server/index.ts', 'src/server/other.ts'], faces: ['A', 'C'],
      // 2026-08-09：SC-2 承担后两个闸（verify 只做部分闸验证）
      gates: [A.GATES[2], A.GATES[3]],
      hardening_classes: [],
      preflight: realPreflight('npm', ['test'], 'SC-2'),
    },
    {
      id: 'SC-3', priority_id: 'P2', kind: 'fix', granularity: 'anchor',
      change: '修渲染泄漏', holds: '引用释放',
      verify: { cmd: 'vitest', args: ['run', '-t', 'failing', 'src/fail.test.js'] }, expect: 'pass',
      anchor_paths: ['src/lib/foo.ts', 'src/server/baz.ts'], faces: ['B', 'C', 'D'],
      // 2026-08-09：P2 只有 SC-3 一条 SC → 全量声明（4 闸 + 全 10 类）
      gates: [...A.GATES],
      hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      predicted_invariant: '不泄漏', predicted_primary_face: 'B',
      preflight: { ...realPreflight('vitest', ['run', '-t', 'failing', 'src/fail.test.js'], 'SC-3'), disposition: '接受（替身红→绿有意义）' },
    },
  ];
  const priorities = [
    { id: 'P1', title: '任务一', why: 'w', pr_split: { suggested_prs: 1, functional_pr: true } },
    { id: 'P2', title: '任务二', why: 'w', pr_split: { suggested_prs: 1, functional_pr: false } },
  ];

  // 全维度覆盖（authority 动态）：B 面 n_a（anchor 全非 UI → no_ui_paths 合法）；
  // face covered 格必须由「声明了该面」的 SC 支持（P0-B），无声明 → n_a(no_claim_made)
  const dims = [
    ...A.FACES.map((f) => ({ kind: 'face', dim: f })),
    ...A.GATES.map((g) => ({ kind: 'gate', dim: g })),
    ...A.HARDENING_CLASSES.map((h) => ({ kind: 'hardening', dim: String(h) })),
  ];
  const coverage = [];
  for (const task of priorities) {
    const taskScs = scs.filter((s) => s.priority_id === task.id);
    for (const { kind, dim } of dims) {
      if (kind === 'face' && dim === 'B') {
        coverage.push({ task_id: task.id, dimension_kind: kind, dimension_id: dim, status: 'n_a', sc_ids: [],
          reason_code: 'no_ui_paths', evidence: 'anchor 全非 UI 路径，无 UI 面可判' });
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

  // waves 真实重算落盘（SC-1 与 SC-3 共享 src/lib/foo.ts → fix 池同组 g1；SC-2 verify → 尾波 v1）
  const wavesResult = await buildWavesPlan({ scs, authority: A });
  assert.deepEqual(wavesResult.waves.flatMap((w) => w.groups).map((g) => g.group_id), ['g1', 'v1'],
    '基线前提：重算 waves 恰好 2 组 g1/v1');

  // 按重算 waves 逐组建 packet（每组恰好一个）——与 waves 计划面精确对账（c1/c2/c3/c4 全过）
  const packets = wavesResult.waves.flatMap((w) => w.groups).map((g) => ({
    group_id: g.group_id,
    scs_inline: g.sc_ids.map((sid) => scs.find((s) => s.id === sid)), // 与顶层 scs 同引用，逐字一致
    allowed_paths: ['src/lib', 'src/server'],
    forbidden: ['node_modules'],
    verify_cmds: ['node --test'],
    submit_format: '{status: PASS|BLOCKED, sc_results:[{sc_id, status, evidence}], changed_files, residual_risks}',
    instruction: '用 goal skill 执行本派工包',
    needs_three_review: true,
    manifest_core_hash: '', // 占位，下面回填
  }));

  const manifest = {
    schema_version: '1.0.0',
    slug: SLUG,
    goal: 'dispatch-binding 自洽基线',
    context_refs: [],
    priorities,
    scs,
    coverage,
    waves: wavesResult.waves,
    dispatch: { capacity: wavesResult.capacity, packets },
  };
  const h = manifestCoreHash(manifest);
  manifest.manifest_core_hash = h;
  for (const p of manifest.dispatch.packets) p.manifest_core_hash = h;
  assert.equal(manifestCoreHash(manifest), h, 'hash 回填必须不动点（黑名单剔除）');
  return manifest;
}

// 变异写盘前处理：重算 waves（必须与基线相等——变异只动投递面）+ 重算 hash 回填（顶层 + 每个 packet）
async function prepareMutated(mutated) {
  const r = await buildWavesPlan({ scs: mutated.scs, authority: A });
  assert.deepEqual(r.waves, baselineWaves, '变异不得改变 waves 重算结果（变异只动投递面）');
  mutated.waves = r.waves;
  mutated.dispatch.capacity = r.capacity;
  const h = manifestCoreHash(mutated);
  mutated.manifest_core_hash = h;
  for (const p of mutated.dispatch.packets) p.manifest_core_hash = h;
  assert.equal(manifestCoreHash(mutated), h, '变异后 hash 回填必须不动点');
}

// 事件集断言：前置三闸 ok，manifest-validate 唯一红（目标码），后继闸全部 not_run
function assertDispatchRed(caseId, f, code) {
  const byGate = Object.fromEntries(f.events.map((e) => [e.gate, e]));
  for (const g of ['authority', 'load', 'hashes']) {
    assert.equal(byGate[g].status, 'ok', `[${caseId}] 前置闸 ${g} 应 ok`);
  }
  assert.equal(byGate['manifest-validate'].status, 'error', `[${caseId}] manifest-validate 必须红`);
  assert.equal(byGate['manifest-validate'].error_code, code,
    `[${caseId}] 唯一红必须 ${code}，实际 ${byGate['manifest-validate'].error_code}`);
  for (const g of ['coverage-matrix', 'waves', 'preflight']) {
    assert.equal(byGate[g].status, 'not_run', `[${caseId}] 前置闸红 → ${g} 必须 not_run（不是第二个红）`);
  }
}

// ── 五支变异：每支从基线深拷贝只改一处，目标错误码唯一 ──

const MUTATIONS = [
  {
    id: 'D1',
    name: '删 packet 内 SC（SC 在计划与 waves 中却永不投递 → 投递覆盖不全）',
    code: 'DISPATCH_SC_COVERAGE_INCOMPLETE',
    apply: (m) => {
      const g1 = m.dispatch.packets.find((p) => p.group_id === 'g1');
      assert.ok(g1, 'D1 前提：g1 packet 存在');
      const i = g1.scs_inline.findIndex((s) => s.id === 'SC-3');
      assert.ok(i >= 0, 'D1 前提：g1 装有 SC-3');
      g1.scs_inline.splice(i, 1); // 只删这一个内联 SC
    },
  },
  {
    id: 'D2',
    name: 'packet.group_id 指向不存在的组',
    code: 'DISPATCH_GROUP_SET_MISMATCH',
    apply: (m) => {
      const g1 = m.dispatch.packets.find((p) => p.group_id === 'g1');
      assert.ok(g1, 'D2 前提：g1 packet 存在');
      g1.group_id = 'gX'; // 只改这一个字段
    },
  },
  {
    id: 'D3',
    name: '两个 packet 指向同一组（复制 g1 packet 追加 → 组计数 2 ≠ 1）',
    code: 'DISPATCH_GROUP_PACKET_COUNT',
    apply: (m) => {
      const g1 = m.dispatch.packets.find((p) => p.group_id === 'g1');
      assert.ok(g1, 'D3 前提：g1 packet 存在');
      m.dispatch.packets.push({ ...g1, scs_inline: [...g1.scs_inline] }); // 只新增一个同组 packet
    },
  },
  {
    id: 'D4',
    name: 'SC 跨组搬运（g1 的 SC-3 移进 v1 的 packet → 两组投递与计划都不等）',
    code: 'DISPATCH_GROUP_SC_MISMATCH',
    apply: (m) => {
      const g1 = m.dispatch.packets.find((p) => p.group_id === 'g1');
      const v1 = m.dispatch.packets.find((p) => p.group_id === 'v1');
      assert.ok(g1 && v1, 'D4 前提：g1/v1 packet 存在');
      const i = g1.scs_inline.findIndex((s) => s.id === 'SC-3');
      assert.ok(i >= 0, 'D4 前提：SC-3 在 g1');
      g1.scs_inline.splice(i, 1);
      v1.scs_inline.push(m.scs.find((s) => s.id === 'SC-3')); // 顶层对象 → 逐字一致，不触发 INLINE_MISMATCH
    },
  },
  {
    id: 'D5',
    name: 'SC 在两个 packet 里重复出现（v1 多装一个 SC-1 → 恰出现一次被违反）',
    code: 'DISPATCH_SC_COVERAGE_INCOMPLETE',
    apply: (m) => {
      const v1 = m.dispatch.packets.find((p) => p.group_id === 'v1');
      assert.ok(v1, 'D5 前提：v1 packet 存在');
      v1.scs_inline.push(m.scs.find((s) => s.id === 'SC-1')); // 只新增这一个内联 SC
    },
  },
];

// ── 基线：final 七闸全 ok + release 双绿（新判据不拒死合法输入）──

test('P0 基线：自洽完整 manifest 走 final 七闸 + 两最终检查全 ok + release 双绿', async () => {
  const goalDir = makeGoalDir();
  writeManifest(goalDir, baseline);
  writePlan(goalDir, baseline);
  writeReviewReceipt(goalDir, baseline);

  const f = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(f.ok, true, `基线应全绿: ${f.error ?? ''}`);
  assert.equal(f.events.length, GATE_NAMES.length + FINAL_CHECK_GATES.length);
  for (const e of f.events) {
    assert.equal(e.status, 'ok', `闸 ${e.gate} 应为 ok，实际 ${e.status}`);
    assert.equal(e.error_code, null);
  }

  const rel = await runReleaseGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(rel.ok, true, `release 应通过: ${rel.error ?? ''}`);
  assert.ok(Array.isArray(rel.packets) && rel.packets.length === 2, 'release 必须输出逐组的 2 个 packet');
});

// ── 五支变异：每支「唯一红 = 目标错误码，后继闸 not_run」──

for (const tc of MUTATIONS) {
  test(`P0 变异/${tc.id}: ${tc.name} → 唯一红 ${tc.code}，后继闸 not_run`, async () => {
    const goalDir = makeGoalDir();
    const mutated = JSON.parse(JSON.stringify(baseline)); // 深拷贝（变异不叠加）
    tc.apply(mutated);
    await prepareMutated(mutated);
    writeManifest(goalDir, mutated);
    writePlan(goalDir, mutated); // 投影区按变异后 manifest 渲染；变异在 manifest-validate 先红，最终检查不会跑到

    const f = await runFinalGate({ slug: SLUG, goalDir, repoDir });
    assert.equal(f.ok, false, `[${tc.id}] 变异必须 fail`);
    assertDispatchRed(tc.id, f, tc.code);
  });
}
