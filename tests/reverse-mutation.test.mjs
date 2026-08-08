// tests/reverse-mutation.test.mjs — 反向变异族 + 流水线事件集预测（SC-7 / F27）。
//
// 核心机制 C（判据所有权 + 定序）：manifest-validate(final) → coverage-matrix。
// 前置闸 error 时后继闸记 not_run（**不是**第二个红——所有权拆分后，强行独立跑后继闸
// 等于喂它不满足前置条件的输入，把所有权又搅浑）。
//
// 每支变异跑前显式写下预测事件集 {gate, status ∈ {ok, error, not_run}, error_code}[]，
// 实跑后逐条对照；判据是「实际事件集恰好等于预测事件集」，不是「只有一个闸红」。
//
// 对照组（SC-7d）：baseline = tests/fixtures/joint/complete.json（静态文件，双闸全绿，
// 由 joint/generate-complete.mjs 生成）。每支变异从 baseline 的深拷贝上**只改一处**，
// 变异互相不叠加；测试只读 fixture 文件，末尾断言文件字节未被改动。
//
// 红集与预测不符 → 停下修闸或修预测表并说清理由，绝不调 fixture 迁就。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadAuthority } from '../scripts/lib/authority.mjs';
import { canonicalRepo } from '../scripts/lib/repo-identity.mjs';
import { deriveInputPaths } from '../scripts/coverage-matrix.mjs';
import { manifestCoreHash } from '../scripts/lib/hashing.mjs';
import { buildWavesPlan } from '../scripts/waves-plan.mjs';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(SKILL_ROOT, 'tests', 'fixtures', 'joint', 'complete.json');
const TASK = 'P1';

let A;            // 真实 authority（before 里 await）
let repoDir;      // 临时 git repo（coverage-matrix 的 --cwd，canonical = xindong/mivo-canvas）
let baseline;     // joint fixture 静态内容（字节级对照组）
let tmpCounter = 0;

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-joint-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  return dir;
}

before(async () => {
  A = await loadAuthority();
  repoDir = makeTempRepo();
  baseline = readFileSync(FIXTURE_PATH, 'utf8');
  // 测试前提：当前 authority 面集 = A..G（维度/面名随 authority 演进时先报红再修预测表，不静默）
  assert.deepEqual(A.FACES, ['A', 'B', 'C', 'D', 'E', 'F', 'G'], '测试前提：FACES = A..G');
  assert.ok(A.FACES.includes('A') && A.FACES.includes('C') && A.FACES.includes('F'), '测试前提：A/C/F 在 FACES 中');
  assert.ok(!A.FACES.includes('H'), '测试前提：H 不在 FACES（M5 的未知维度）');
  assert.notEqual(A.FACES[3], undefined, '测试前提：第 4 面存在（M1 删除靶点）');
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ── 流水线定序器：manifest-validate(final) → coverage-matrix（前置 error → 后继 not_run）──
// 复证升级（lead 2026-08-09 裁决）：coverage 违规以**完整违规集**记录（不只首行），
// assertEvents 断言「违规集恰好等于预测那一条」——消灭「排序碰巧」形状测试脆弱性。
function runPipeline(doc) {
  const tmp = join(tmpdir(), `tp-joint-${tmpCounter += 1}-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  const events = [];
  try {
    execFileSync(
      'node', ['scripts/manifest-validate.mjs', '--manifest', tmp, '--stage=final'],
      { cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    events.push({ gate: 'manifest-validate', status: 'ok' });
  } catch (e) {
    events.push({ gate: 'manifest-validate', status: 'error', error_code: firstManifestCode(e.stderr ?? '') });
    // 定序语义：前置闸 error → 后继闸 not_run（不独立跑 coverage 取第二个红）
    events.push({ gate: 'coverage-matrix', status: 'not_run' });
    rmSync(tmp, { force: true });
    return events;
  }
  try {
    execFileSync(
      'node', ['scripts/coverage-matrix.mjs', '--manifest', tmp, '--cwd', repoDir],
      { cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    events.push({ gate: 'coverage-matrix', status: 'ok' });
  } catch (e) {
    const stderr = e.stderr ?? '';
    events.push({
      gate: 'coverage-matrix', status: 'error', error_code: firstCoverageCode(stderr),
      codes: coverageCodes(stderr), // 完整违规集（供 assertEvents 精确断言）
    });
  }
  rmSync(tmp, { force: true });
  return events;
}

// coverage-matrix stderr 违规行形态（F3，2026-08-09）: `<task_id> <dimension_kind> <dimension_id> [<CODE>]`；
// 提取全部违规行的 error_code（与 firstCoverageCode 同口径，但不只取首行）
function coverageCodes(stderr) {
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .map((l) => { const m = l.match(/\[([A-Z][A-Z0-9_]+)\]/); return m ? m[1] : null; })
    .filter((c) => c !== null);
}

// manifest-validate stderr 行形态: `  [CODE] path — msg`（取第一个 [CODE]）
function firstManifestCode(stderr) {
  const m = stderr.match(/\[([A-Z][A-Z0-9_]+)\]/);
  return m ? m[1] : '(no code)';
}

// coverage-matrix stderr 行形态: `<task_id> <dimension_kind> <dimension_id> [<CODE>]`（取第一个 [CODE]）
function firstCoverageCode(stderr) {
  const m = stderr.match(/\[([A-Z][A-Z0-9_]+)\]/);
  return m ? m[1] : '(no code)';
}

// 断言事件集：失败信息必须能看出「预测 vs 实际」的差异
function assertEvents(caseId, actual, predicted) {
  // 事件集本体（剔除 codes 附属字段）逐项相等
  assert.deepEqual(
    actual.map((e) => ({ gate: e.gate, status: e.status, error_code: e.error_code ?? null })),
    predicted.map((e) => ({ gate: e.gate, status: e.status, error_code: e.error_code ?? null })),
    `[${caseId}] 实际事件集 ≠ 预测事件集\n--- 预测 ---\n${JSON.stringify(predicted, null, 2)}\n--- 实际 ---\n${JSON.stringify(actual, null, 2)}`
  );
  // 复证升级：coverage error 时**违规集恰好等于预测那一条**（数量 1 + code 精确匹配，
  // 不许靠输出排序「碰巧」通过——任何串码/多码都红）
  const cov = actual.find((e) => e.gate === 'coverage-matrix');
  const covPred = predicted.find((e) => e.gate === 'coverage-matrix');
  if (cov && cov.status === 'error' && covPred && covPred.error_code) {
    assert.deepEqual(
      cov.codes, [covPred.error_code],
      `[${caseId}] coverage 违规集必须恰好等于预测的 ${covPred.error_code}，实际 ${JSON.stringify(cov.codes)}`
    );
  }
}

// ── 变异定义表：每支显式写预测事件集 + apply（只改一处）──

const M1 = {
  id: 'M1', name: '删 D 维度一格',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'COVERAGE_CELL_MISSING' },
  ],
  apply: (m) => {
    const i = m.coverage.findIndex(
      (c) => c.task_id === TASK && c.dimension_kind === 'face' && String(c.dimension_id) === A.FACES[3]
    );
    assert.ok(i >= 0, 'M1 前提：P1 的第 4 面 cell 存在');
    m.coverage.splice(i, 1); // 只删这一格
  },
};

const M2 = {
  id: 'M2', name: '单任务全 n_a（A/C/F 无一 covered）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'TASK_ALL_NA' },
  ],
  apply: (m) => {
    for (const c of m.coverage) {
      if (c.task_id === TASK && c.dimension_kind === 'face' && ['A', 'C', 'F'].includes(String(c.dimension_id))) {
        c.status = 'n_a';
        c.reason_code = 'no_claim_made';
        c.evidence = '本 task 对这三面不作声称';
        c.sc_ids = [];
      }
    }
  },
};

const M3 = {
  id: 'M3', name: 'n_a 缺 reason_code（schema 刻意留可选，所有权归 coverage）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'NA_MISSING_REASON_CODE' },
  ],
  apply: (m) => {
    const cell = m.coverage.find(
      (c) => c.task_id === TASK && c.dimension_kind === 'hardening' && String(c.dimension_id) === '1'
    );
    assert.ok(cell && cell.status === 'n_a', 'M3 前提：P1 hardening:1 是合法 n_a cell（fixture 内建）');
    delete cell.reason_code; // 只删这一个字段
  },
};

const M4 = {
  id: 'M4', name: 'covered 引用跨任务 sc_id',
  predict: [
    { gate: 'manifest-validate', status: 'error', error_code: 'CELL_SC_CROSS_TASK' },
    { gate: 'coverage-matrix', status: 'not_run' },
  ],
  apply: (m) => {
    const cell = m.coverage.find(
      (c) => c.task_id === TASK && c.dimension_kind === 'face' && String(c.dimension_id) === 'A'
    );
    assert.ok(cell, 'M4 前提：P1 face A cell 存在');
    cell.sc_ids = ['SC-3']; // SC-3 属于 P2 → 跨任务
  },
};

const M5 = {
  id: 'M5', name: '未知 dimension_id（face 维度新增 H 格）',
  predict: [
    { gate: 'manifest-validate', status: 'error', error_code: 'UNKNOWN_DIMENSION_ID' },
    { gate: 'coverage-matrix', status: 'not_run' },
  ],
  apply: (m) => {
    // 新增形态（不替换任何现有格）：coverage 单独跑时对未知维度格 exit 0（不越权判），
    // 证明「结构红只由 manifest-validate 报」——但定序流水线里 coverage 根本不该被跑到
    m.coverage.push({
      task_id: TASK, dimension_kind: 'face', dimension_id: 'H', // ∉ FACES（before 已断言）
      status: 'covered', sc_ids: ['SC-1'], evidence: 'e',
    });
  },
};

const M6 = {
  id: 'M6', name: '改 ui_prediction.matched_paths 内一个值（改结构对象内的值，不是删自由文本）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'B_DIM_UIPRED_MISMATCH' },
  ],
  apply: (m) => {
    const b = bCell(m);
    assert.ok(Array.isArray(b.ui_prediction.matched_paths) && b.ui_prediction.matched_paths.length > 0, 'M6 前提：matched_paths 非空');
    b.ui_prediction.matched_paths[0] = 'src/app/Wrong.tsx'; // 只改这一个值
  },
};

// M7：删**命中 UI** 的路径后重算写回。注意：它**不隔离**「input_paths 精确比对」这条样本防裁剪
// guard。在真实仓逐路径实测（派生样本 [App, Canvas, util, server]，matched=[App, Canvas]）：
//   - 删 App/Canvas（UI 命中）→ matched_paths 变 → 三输出 ≠ 完整输入现跑 → 红（guard b，与 guard a 同码）
//   - 删 util/server（非 UI 命中）→ 三输出不变 → 红只能来自 input_paths ≠ 派生（guard a）
// M7 删的是前者：两条独立红路径（a 与 b）报**同一个** error_code，测试只断言 error_code，
// 所以把 guard (a) 整段删掉 M7 依然红——它满足"恰好红 1 条"但不满足隔离判据。
// 真正隔离 guard (a) 的是 M7-input。
const M7 = {
  id: 'M7', name: '删 UI 命中路径 + 重算写回（锁「输出与现跑不一致」guard；不隔离样本防裁剪，见注释实测）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'B_DIM_UIPRED_MISMATCH' },
  ],
  apply: (m) => {
    const derived = deriveInputPaths(m, TASK);
    // 从派生样本里删掉一个**确实命中的 UI 路径**（matched_paths 里有的）
    const uiHit = m.coverage
      .find((c) => c.task_id === TASK && c.dimension_kind === 'face' && String(c.dimension_id) === 'B')
      .ui_prediction.matched_paths;
    assert.ok(uiHit.length >= 1, 'M7 前提：P1 B 面至少有 1 个命中 UI 路径');
    const cropped = derived.filter((p) => p !== uiHit[0]);
    assert.ok(cropped.length < derived.length, 'M7 前提：裁剪确实发生');
    // 自洽伪造：三输出用 matcher 对「裁剪后输入」的真实返回值（内部自洽，但 input_paths ≠ 派生值）
    const { path, registry } = A.resolveUiRegistry(canonicalRepo({ cwd: repoDir }));
    const run = A.matchUiPaths(registry, cropped);
    bCell(m).ui_prediction = {
      input_paths: cropped,
      registry_path: path,
      config_hash: run.config_hash,
      touches_ui: run.touches_ui,
      matched_paths: run.matched_paths,
    };
  },
};

// M7-input：真正隔离「input_paths 精确比对」guard 的变异（反向变异判据 = 隔离，不是恰好红 1 条）。
// 与 M7 的差别：删的是**非 UI 命中**路径（不在 matched_paths 里）——裁剪后重算的三输出与
// 完整输入重算的完全相同，matcher 输出 guard 不会红；唯一可红依据就是 input_paths 精确比对。
// 前提断言（被删路径存在 / 不在 matched / 裁剪后三输出不变）任一不成立即红，不许静默退化。
const M7_INPUT = {
  id: 'M7-input',
  name: '删非 UI 命中路径 + 重算写回（唯一可红依据 = input_paths 精确比对，隔离成立）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'B_DIM_UIPRED_MISMATCH' },
  ],
  apply: (m) => {
    const derived = deriveInputPaths(m, TASK);
    const { path, registry } = A.resolveUiRegistry(canonicalRepo({ cwd: repoDir }));
    const full = A.matchUiPaths(registry, derived);
    // 选一条「派生样本里有、但 matcher 不命中」的路径：删它不改变 matcher 三输出
    const victim = derived.find((p) => !full.matched_paths.includes(p));
    assert.ok(victim !== undefined, 'M7-input 前提：派生样本中存在非 UI 命中路径');
    assert.ok(derived.includes(victim), 'M7-input 前提：被删路径确实在派生样本里');
    assert.ok(!full.matched_paths.includes(victim), 'M7-input 前提：被删路径不在 matched_paths（非 UI 命中）');
    const cropped = derived.filter((p) => p !== victim);
    assert.ok(cropped.length < derived.length, 'M7-input 前提：裁剪确实发生');
    // 隔离前提实证：裁剪后重算三输出与完整输入重算完全一致 → matcher 输出 guard 不会红，
    // 唯一可红依据只剩 input_paths 精确比对
    const run = A.matchUiPaths(registry, cropped);
    assert.deepEqual(
      { config_hash: run.config_hash, touches_ui: run.touches_ui, matched_paths: run.matched_paths },
      { config_hash: full.config_hash, touches_ui: full.touches_ui, matched_paths: full.matched_paths },
      'M7-input 前提：裁剪非 UI 命中路径后 matcher 三输出必须不变'
    );
    bCell(m).ui_prediction = {
      input_paths: cropped,
      registry_path: path,
      config_hash: run.config_hash,
      touches_ui: run.touches_ui,
      matched_paths: run.matched_paths,
    };
  },
};

const M8 = {
  id: 'M8', name: '非权威 registry（registry_path 换成 registry.cindy.json）',
  predict: [
    { gate: 'manifest-validate', status: 'ok' },
    { gate: 'coverage-matrix', status: 'error', error_code: 'B_DIM_UIPRED_MISMATCH' },
  ],
  apply: (m) => {
    const cindyPath = A.resolveUiRegistry('makecindy/cindy').path;
    const mivoPath = A.resolveUiRegistry(canonicalRepo({ cwd: repoDir })).path;
    assert.notEqual(cindyPath, mivoPath, 'M8 前提：cindy registry ≠ 本仓权威 registry');
    bCell(m).ui_prediction.registry_path = cindyPath; // 只改这一个字段
  },
};

function bCell(m) {
  const cell = m.coverage.find(
    (c) => c.task_id === TASK && c.dimension_kind === 'face' && String(c.dimension_id) === 'B'
  );
  assert.ok(cell && cell.ui_prediction, '前提：P1 B 维度 cell 携带 ui_prediction');
  return cell;
}

// ── SC-7a：joint fixture 双闸全绿（真实 CLI 命令）──

test('SC-7a: joint fixture 双闸全绿（manifest-validate --stage=final exit 0 且 coverage-matrix exit 0）', () => {
  let out;
  out = execFileSync(
    'node', ['scripts/manifest-validate.mjs', '--manifest', FIXTURE_PATH, '--stage=final'],
    { cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.match(out, /manifest-validate: PASS/);
  out = execFileSync(
    'node', ['scripts/coverage-matrix.mjs', '--manifest', FIXTURE_PATH, '--cwd', repoDir],
    { cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.equal(out.trim(), ''); // 无违规即无 stderr 输出、exit 0（execFileSync 抛出即失败）
});

// ── SC-7b/7c：八支变异，每支「预测事件集 == 实际事件集」；M4/M5 的 coverage 记 not_run ──

for (const tc of [M1, M2, M3, M4, M5, M6, M7, M7_INPUT, M8]) {
  test(`SC-7b/${tc.id}: ${tc.name} → 事件集 ${JSON.stringify(tc.predict)}`, () => {
    const mutated = JSON.parse(baseline); // 深拷贝 baseline（SC-7d：变异不叠加）
    tc.apply(mutated);
    const actual = runPipeline(mutated);
    assertEvents(tc.id, actual, tc.predict);
  });
}

// ── SC-7d：全部变异跑完后，对照组文件未被污染（字节级）──

test('SC-7d: 对照组不被污染（baseline fixture 文件在全部变异后字节不变）', () => {
  assert.equal(readFileSync(FIXTURE_PATH, 'utf8'), baseline, 'joint/complete.json 被测试改动（必须只读）');
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 真实 final-gate CLI 走查（2026-08-09）：
// 覆盖闸红时，外层 receipt 必须转述子闸原码（error_code == 子闸原码，不是 generic
// COVERAGE_MATRIX_FAIL），后继闸（waves/preflight）全 not_run。改走真实 final-gate CLI
// （不是自制两闸 runner），证明 wrapper 的转述行为在真实定序回放上成立。
// 前置：joint fixture 的 waves 与 waves-plan 重算不等（2026-08-09 实测：落盘 [g1: SC-1,2,3]
// vs 重算 wave1[g1,g2]+wave2[v1]），所以这里变异后重算 waves 落盘 + 按重算 waves 重建 packets
// + hash 回填（诚实落盘：waves 一致性闸要求落盘 == 重算；dispatch-completeness 要求投递面 == 计划面）。
// ─────────────────────────────────────────────────────────────────────────────

const FG_SLUG = 'joint-complete'; // 必须与 joint fixture 的 manifest.slug 一致（slug 身份绑定闸）
let fgCounter = 0;

async function makeFinalReady(mutated) {
  const goalDir = mkdtempSync(join(tmpdir(), `tp-fg-${fgCounter += 1}-`));
  const doc = JSON.parse(JSON.stringify(mutated));
  const A2 = await loadAuthority();
  const recomputed = await buildWavesPlan({ scs: doc.scs, authority: A2 });
  const template = JSON.parse(baseline).dispatch.packets[0];
  doc.waves = recomputed.waves;
  doc.dispatch = {
    capacity: recomputed.capacity,
    packets: recomputed.waves.flatMap((w) => w.groups).map((g) => ({
      group_id: g.group_id,
      scs_inline: g.sc_ids.map((sid) => doc.scs.find((s) => s.id === sid)),
      allowed_paths: template.allowed_paths,
      forbidden: template.forbidden,
      verify_cmds: template.verify_cmds,
      submit_format: template.submit_format,
      instruction: template.instruction,
      needs_three_review: template.needs_three_review,
      manifest_core_hash: '',
    })),
  };
  const h = manifestCoreHash(doc);
  doc.manifest_core_hash = h;
  for (const p of doc.dispatch.packets) p.manifest_core_hash = h;
  assert.equal(manifestCoreHash(doc), h, 'final-gate 走查产物 hash 必须不动点');
  writeFileSync(join(goalDir, 'task-manifest.json'), JSON.stringify(doc, null, 2));
  writeFileSync(join(goalDir, 'priority-plan.md'), `# ${FG_SLUG}\n\nF3 final-gate CLI 走查 fixture。\n`);
  return goalDir;
}

function runFgCli(goalDir) {
  const r = spawnSync(
    process.execPath,
    ['scripts/final-gate.mjs', '--slug', FG_SLUG, '--goal-dir', goalDir, '--repo-dir', repoDir],
    { cwd: SKILL_ROOT, encoding: 'utf8' },
  );
  return { status: r.status, stderr: r.stderr ?? '' };
}

/** 从 final-gate CLI stderr 解析逐闸事件行 `  [gate] status [CODE]` */
function fgEvents(stderr) {
  const events = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/^\s*\[([a-z-]+)\] (ok|error|not_run)(?: ([A-Z][A-Z0-9_]+))?$/);
    if (m) events.push({ gate: m[1], status: m[2], error_code: m[3] ?? null });
  }
  return events;
}

/** 断言：七闸事件集恰好等于预测 + coverage 闸 error_code == 子闸原码 + 后继全 not_run */
function assertFgCoverageRed(caseId, events, code) {
  assert.deepEqual(
    events,
    [
      { gate: 'authority', status: 'ok', error_code: null },
      { gate: 'load', status: 'ok', error_code: null },
      { gate: 'hashes', status: 'ok', error_code: null },
      { gate: 'manifest-validate', status: 'ok', error_code: null },
      { gate: 'coverage-matrix', status: 'error', error_code: code },
      { gate: 'waves', status: 'not_run', error_code: null },
      { gate: 'preflight', status: 'not_run', error_code: null },
    ],
    `[${caseId}] 七闸事件集 ≠ 预测（coverage 必须转述 ${code}，后继必须 not_run）`
  );
}

for (const tc of [
  {
    id: 'M1-fg',
    name: '真实 final-gate：删 P1 face D 格 → coverage 转述 COVERAGE_CELL_MISSING',
    code: 'COVERAGE_CELL_MISSING',
    apply: M1.apply,
  },
  {
    id: 'M2-fg',
    name: '真实 final-gate：A/C/F 全 n_a → coverage 转述 TASK_ALL_NA',
    code: 'TASK_ALL_NA',
    apply: M2.apply,
  },
  {
    id: 'M9-fg',
    name: '真实 final-gate：face D 格指向未声明 D 的 SC → coverage 转述 CELL_FACE_NOT_DECLARED',
    code: 'CELL_FACE_NOT_DECLARED',
    apply: (m) => {
      const cell = m.coverage.find(
        (c) => c.task_id === TASK && c.dimension_kind === 'face' && String(c.dimension_id) === 'D'
      );
      assert.ok(cell, 'M9-fg 前提：P1 face D 格存在');
      assert.equal(cell.status, 'n_a', 'M9-fg 前提：P1 face D 是 n_a（joint 中声明 D 的 SC-3 属 P2）');
      // n_a 格不触发 CELL_FACE_NOT_DECLARED（仅 covered/n_a_predicted 触发）；
      // 变异：改为 covered 但 sc_ids 指向 faces 不含 D 的 SC-1 → 恰好 CELL_FACE_NOT_DECLARED
      cell.status = 'covered';
      cell.sc_ids = ['SC-1']; // SC-1 faces=[A,B,C] 不含 D
      delete cell.reason_code;
      cell.evidence = 'e';
    },
  },
]) {
  test(`SC-7b/${tc.id}: ${tc.name}`, async () => {
    const mutated = JSON.parse(baseline);
    tc.apply(mutated);
    const goalDir = await makeFinalReady(mutated);
    const r = runFgCli(goalDir);
    assert.equal(r.status, 2, `final-gate CLI 必须 exit 2: ${r.stderr}`);
    assertFgCoverageRed(tc.id, fgEvents(r.stderr), tc.code);
    rmSync(goalDir, { recursive: true, force: true });
  });
}
