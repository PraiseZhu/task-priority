// tests/plan-projection.test.mjs — P1-A 双产物投影闸（单元 + 四支反向变异）。
//
// 背景（lead 2026-08-09 实测）：manifestCoreHash 与 planHash 是两个互不引用的函数，final-gate
// 只分别校验「各自与自己的 receipt 相符」，没有任何跨产物语义比对——把 priority-plan.md 里
// SC-1 的文字改成与 manifest 不一致，七闸全过、release 放行。
//
// 修复：marker 包夹的机器投影区（scripts/lib/plan-projection.mjs 单一实现）。final-gate 第七闸后
// 追加最终检查：从 manifest **现渲染**投影，与 plan 内 marker 区块逐字节比对，不等即拒
// （PLAN_PROJECTION_MISMATCH / 缺 marker → PLAN_PROJECTION_MISSING）。marker 区外自由散文不受约束。
//
// 四支反向变异（判据 = 恰好红一条，另加对照组防「一律拒」）：
//   P1 只改 plan 的 marker 区块     → PLAN_PROJECTION_MISMATCH（唯一红，review-receipt not_run）
//   P2 只改 manifest 的 SC         → PLAN_PROJECTION_MISMATCH（投影与 plan 不符）
//   P3 两边同步改（重渲染）         → **对照组必须通过**（证明闸不是做成了「一律拒」）
//   P4 改 marker 区外的自由散文     → **必须通过**（人话归人，事实归机器）
//
// 事件集纪律同 reverse-mutation：前置七闸必须全 ok（红点只能落在 projection 闸），
// 红与预测不符 → 停下修闸或修预测并说清理由，不调基线迁就。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadAuthority } from '../scripts/lib/authority.mjs';
import { manifestCoreHash, draftAncestorHash, PLAN_RECEIPTS_MARKER } from '../scripts/lib/hashing.mjs';
import {
  renderPlanProjection,
  extractPlanProjection,
  PLAN_PROJECTION_START,
  PLAN_PROJECTION_END,
} from '../scripts/lib/plan-projection.mjs';
import {
  REVIEW_RECEIPT_FILENAME,
  readShippedGapCatalog,
  gapCatalogFingerprint,
} from '../scripts/lib/review-receipt.mjs';
import { buildWavesPlan } from '../scripts/waves-plan.mjs';
import { runFinalGate, MANIFEST_FILENAME, PLAN_FILENAME, GATE_NAMES } from '../scripts/final-gate.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'plan-projection';

// ─────────────────────────────────────────────────────────────────────────────
// 测试基础设施（与 final-gate.test.mjs 同构：临时 goal + 临时 git repo + 真实 preflight）
// ─────────────────────────────────────────────────────────────────────────────

function makeGoalDir() {
  return mkdtempSync(path.join(tmpdir(), 'plan-proj-goal-'));
}

function makeRepoDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-proj-repo-'));
  cpSync(path.join(SKILL_ROOT, 'tests', 'fixtures', 'preflight', 'repo-template'), dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=plan-proj-test', '-c', 'user.email=test@test.local', 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=plan-proj-test', '-c', 'user.email=test@test.local', 'commit', '-qm', 'init']);
  return dir;
}

/** 真实 sc-preflight 产物（同 final-gate.test.mjs：手写 status 会被 P0#3 闸拒） */
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
  const pf1 = realPreflight(repoDir, scs[0]);
  assert.equal(pf1.status, 'green_warn', `SC-1 替身实跑应 green_warn: ${JSON.stringify(pf1)}`);
  scs[0].preflight = { ...pf1, disposition: '接受（替身全绿，空转嫌疑由 lead 处置）' };
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
    goal: 'plan-projection 测试齐全基线',
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

/** 变异后同步 dispatch.packets 的 scs_inline + 重算 hash 回填（不动点） */
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

/** priority-plan.md：自由散文 + 机器投影区（renderPlanProjection）+ receipts 区块 */
function writePlan(goalDir, manifest) {
  const body = [
    `# task-priority 计划（${SLUG}）`,
    '',
    '## 目标',
    'plan-projection 测试 fixture 的 priority-plan.md 正文（自由散文，不受投影闸约束）。',
    '',
    '## SC 清单',
    '| id | 内容 |',
    '|----|------|',
    '| SC-1 | 接入图片 AI 读取 |',
    '| SC-2 | 验证链路 |',
    '| SC-3 | 修复渲染泄漏 |',
    '',
    renderPlanProjection(manifest),
    '',
  ].join('\n');
  writeFileSync(path.join(goalDir, PLAN_FILENAME), body + PLAN_RECEIPTS_MARKER + '\n（receipts 区块）\n', 'utf8');
}

/** 合法 review-receipt（P1-B 闸的前提：缺了它 review-receipt 闸先红，投影变异就测不到红点） */
function writeReviewReceipt(goalDir, manifest) {
  const receipt = {
    slug: manifest.slug,
    draft_manifest_core_hash: draftAncestorHash(manifest),
    gap_catalog_fingerprint: gapCatalogFingerprint(readShippedGapCatalog() ?? ''),
    ledger_fingerprint: 'ledger-0123456789',
    reviewer_count: 1,
    challenges: [{ challenge: 'B 面 n_a 是否敷衍', disposition: '无漏项' }],
  };
  writeFileSync(path.join(goalDir, REVIEW_RECEIPT_FILENAME), JSON.stringify(receipt, null, 2), 'utf8');
}

/** 标准回合：齐全 manifest + plan（含投影区）+ review-receipt */
async function makeReadyRound() {
  const goalDir = makeGoalDir();
  const repoDir = makeRepoDir();
  const manifest = await buildCompleteManifest({ repoDir });
  writeManifest(goalDir, manifest);
  writePlan(goalDir, manifest);
  writeReviewReceipt(goalDir, manifest);
  return { goalDir, repoDir, manifest };
}

/** 投影红断言：前置七闸全 ok，projection 唯一红（目标码），review-receipt not_run */
function assertProjectionOnlyRed(events, code) {
  const byGate = Object.fromEntries(events.map((e) => [e.gate, e]));
  for (const g of GATE_NAMES) {
    assert.equal(byGate[g].status, 'ok', `前置闸 ${g} 应 ok，实际 ${byGate[g].status}`);
  }
  assert.equal(byGate['projection'].status, 'error', 'projection 闸必须是红点');
  assert.equal(byGate['projection'].error_code, code, `唯一红必须 ${code}，实际 ${byGate['projection'].error_code}`);
  assert.equal(byGate['review-receipt'].status, 'not_run', '投影红 → review-receipt 必须 not_run');
}

// ─────────────────────────────────────────────────────────────────────────────
// 单元：render / extract
// ─────────────────────────────────────────────────────────────────────────────

test('plan-projection: 渲染确定性 + extract 往返 + 缺 marker 返回 null', async () => {
  const { goalDir, repoDir, manifest } = await makeReadyRound();
  const proj = renderPlanProjection(manifest);
  assert.equal(renderPlanProjection(manifest), proj, '同一 manifest 渲染必须逐字节相同（确定性）');
  assert.ok(proj.startsWith(PLAN_PROJECTION_START), '区块以起始 marker 开头');
  assert.ok(proj.endsWith(PLAN_PROJECTION_END), '区块以结束 marker 结尾');
  // 往返：从 plan 文件提取 == 现渲染
  const planText = readFileSync(path.join(goalDir, PLAN_FILENAME), 'utf8');
  assert.equal(extractPlanProjection(planText), proj, 'plan 内 marker 区块必须 == renderPlanProjection');
  // 包裹场景 + 缺 marker
  assert.equal(extractPlanProjection('标题\n\n' + proj + '\n\n尾部散文'), proj);
  assert.equal(extractPlanProjection('无 marker 的正文'), null);
  assert.equal(extractPlanProjection(PLAN_PROJECTION_START + '\n只有起点'), null, '只有起点没有终点 → null');
  // 渲染内容 sanity：SC id + 三段式 + waves 分组 + 残余风险都在场
  assert.ok(proj.includes('**SC-1**') && proj.includes('把拖入画布的图片接入 AI 读取链路'), 'SC 清单含 id + change');
  assert.ok(proj.includes('holds: 拖入的图片可被 AI 读取'), 'SC 清单含 holds');
  assert.ok(proj.includes('verify: `vitest run -t passing src/pass.test.js`'), 'SC 清单含 verify 渲染');
  assert.ok(proj.includes('派工组（waves）') && proj.includes('**g1**'), 'waves 分组在场');
  assert.ok(proj.includes('残余风险') && proj.includes('no_ui_paths'), 'coverage n_a 格作为残余风险在场');
  assert.ok(!proj.includes(PLAN_RECEIPTS_MARKER), '投影区不得包含 receipts marker（两区块互相独立）');
  rmSync(goalDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

test('plan-projection: 非对象 manifest → render/extract 抛错（fail-closed）', () => {
  assert.throws(() => renderPlanProjection(null), /manifest 必须是非数组对象/);
  assert.throws(() => renderPlanProjection([1, 2]), /manifest 必须是非数组对象/);
  assert.throws(() => renderPlanProjection({ scs: '不是数组' }), /scs 必须是数组/);
  assert.throws(() => extractPlanProjection(42), /输入必须是字符串/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 四支反向变异（P1/P2 红 + P3/P4 对照组）
// ─────────────────────────────────────────────────────────────────────────────

test('P1: 只改 plan 的 marker 区块 → PLAN_PROJECTION_MISMATCH（唯一红，review-receipt not_run）', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const planPath = path.join(goalDir, PLAN_FILENAME);
  let plan = readFileSync(planPath, 'utf8');
  const block = extractPlanProjection(plan);
  assert.ok(block, '前提：plan 必须有投影区');
  // 只在 marker 区内改一处（marker 本身保留）——这是「人读了旧事实」的缺陷形态
  const tamperedBlock = block.replace('holds: 拖入的图片可被 AI 读取', 'holds: 被篡改的 holds');
  assert.notEqual(tamperedBlock, block, '前提：篡改确实发生');
  writeFileSync(planPath, plan.replace(block, tamperedBlock), 'utf8');

  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, false, '改 marker 区块必须 fail');
  assertProjectionOnlyRed(r.events, 'PLAN_PROJECTION_MISMATCH');
});

test('P2: 只改 manifest 的 SC → PLAN_PROJECTION_MISMATCH（投影与 plan 不符）', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const m = JSON.parse(readFileSync(path.join(goalDir, MANIFEST_FILENAME), 'utf8'));
  m.scs[0].change = '被篡改的 change（plan 投影区仍是旧渲染）';
  writeManifest(goalDir, rewriteHashes(m));

  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, false, 'manifest SC 变更但 plan 未重渲染必须 fail');
  assertProjectionOnlyRed(r.events, 'PLAN_PROJECTION_MISMATCH');
});

test('P3 对照组: 两边同步改（manifest SC + plan 重渲染 + receipt 刷新）→ 必须通过', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const m = JSON.parse(readFileSync(path.join(goalDir, MANIFEST_FILENAME), 'utf8'));
  m.scs[0].change = '两边同步改：接入 AI 读取链路（v2）';
  writeManifest(goalDir, rewriteHashes(m));
  writePlan(goalDir, m); // 投影区按新 manifest 重渲染
  writeReviewReceipt(goalDir, m); // 草稿祖先 hash 已变，receipt 必须刷新（谱系一致）

  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, true, `对照组必须通过（闸不是「一律拒」）: ${r.error ?? ''}`);
  assert.equal(r.events.length, GATE_NAMES.length + 2);
  for (const e of r.events) assert.equal(e.status, 'ok', `闸 ${e.gate} 应为 ok，实际 ${e.status}`);
});

test('P4 对照组: 改 marker 区外的自由散文 → 必须通过（人话归人，事实归机器）', async () => {
  const { goalDir, repoDir } = await makeReadyRound();
  const planPath = path.join(goalDir, PLAN_FILENAME);
  const plan = readFileSync(planPath, 'utf8');
  assert.ok(plan.includes('plan-projection 测试 fixture'), '前提：自由散文在场');
  writeFileSync(planPath, plan.replace('plan-projection 测试 fixture', '自由散文被改，投影闸不得管'), 'utf8');

  const r = await runFinalGate({ slug: SLUG, goalDir, repoDir });
  assert.equal(r.ok, true, `marker 区外自由散文不受约束: ${r.error ?? ''}`);
  assert.equal(r.events.length, GATE_NAMES.length + 2);
  for (const e of r.events) assert.equal(e.status, 'ok', `闸 ${e.gate} 应为 ok，实际 ${e.status}`);
});
