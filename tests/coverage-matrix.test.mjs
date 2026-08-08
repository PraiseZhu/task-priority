// tests/coverage-matrix.test.mjs — 七面反推闸（SC-2）十支测试。
//
// 覆盖清单（派工包要求，≥9 支）：
//   t1  缺格 → COVERAGE_CELL_MISSING（JS 构造 + 静态 missing-cell.json CLI 冒烟）
//   t2  单任务全 n_a（A/C/F 三面全 n_a）→ TASK_ALL_NA
//   t3  n_a 缺 reason_code / 缺 evidence / reason_code 自由文本 → NA_MISSING_REASON_CODE
//   t4  B 维度只填 evidence 自由文本、无 ui_prediction → B_DIM_MISSING_UIPRED
//   t5a B 维度旧 config_hash（registry 已变）→ B_DIM_UIPRED_MISMATCH
//   t5b B 维度 matched_paths 与现跑不一致 → B_DIM_UIPRED_MISMATCH
//   t5c anchor_paths 含 UI 路径但 input_paths 漏掉它（样本被裁剪）→ B_DIM_UIPRED_MISMATCH
//   t6  n_a_predicted 出现在非 B 维度 → NA_PREDICTED_OUT_OF_DOMAIN
//   t7  registry_path 换成非权威 registry → B_DIM_UIPRED_MISMATCH
//   t8  齐全 fixture（静态 complete.json）CLI → exit 0
//   P0-A m1  B=n_a 但派生 touches_ui=true → 恰好 B_DIM_NA_CONTRADICTS_UI（反向变异）
//   P0-A m2  B=n_a 且 anchor 全非 UI（touches_ui=false）→ 对照组零违规（反向变异）
//   P0-B m3  face D 格唯一 sc_id 指向 faces 不含 D 的 SC → 恰好 CELL_FACE_NOT_DECLARED（反向变异）
//   P0-B m4  face D 格指向 faces 含 D 的 SC → 对照组零违规（反向变异）
//
// B 维度的「诚实值」全部由本测试用**真实 authority** 现跑构造（resolveUiRegistry +
// matchUiPaths），fixture 的合法性依赖被测实现自身的派生逻辑——实现派生错、
// 诚实 fixture 就会当场变红（这正是「派生不采信」判据的测试价值）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadAuthority } from '../scripts/lib/authority.mjs';
import { canonicalRepo } from '../scripts/lib/repo-identity.mjs';
import { checkCoverage, deriveInputPaths, ERROR_CODES, REASON_CODES } from '../scripts/coverage-matrix.mjs';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASK = 'P1';

let A;          // authority（before 里 await）
let repoDir;    // 临时 git repo（canonicalRepo 的 cwd）
let registryPath; // 权威 registry 绝对路径（mivo）

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-cov-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:xindong/mivo-canvas.git']);
  return dir;
}

function getRepo() {
  return canonicalRepo({ cwd: repoDir });
}

before(async () => {
  A = await loadAuthority();
  repoDir = makeTempRepo();
  registryPath = A.resolveUiRegistry(getRepo()).path;
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// ── manifest 构造 helper ──
//
// P0-B 修复后的诚实基线：face 格的 sc_ids 必须引用「声明了该面」的 SC——不再允许
// 「一条 SC-1（faces=A/B/C）默认填满全部 21 格」的错误形态（P0-B 实测：complete.json 的
// SC-1 仅声明 A/B/C 却被填进全部 7 面 + 4 闸 + 10 类，两闸 exit 0——这正是 CELL_FACE_NOT_DECLARED
// 要拦的）。三 SC 的 faces 声明并集覆盖全部 7 面；cell() 按面挑声明 SC。
//
// 2026-08-09（同形态第六处）：gate/hardening 绑定随 SC 新增声明字段闭环——此前 14 格
// （4 gate + 10 hardening）无任何绑定，cell() 默认把 gate/hardening 格填 SC-1 即可蒙混过关。
// 与前五处同形态（测试作者为省一个依赖或图一次方便，写出缺陷形态并固化成基线）：
//   1. final-gate.test.mjs 的 B 面 n_a（注释写着「免 git/registry 依赖」）
//   2. coverage-matrix.test.mjs 的 cell() 默认全填 SC-1（本文件旧版，正是第六处的现场）
//   3. joint/complete.json 的 8 个未声明 face 格
//   4. dispatch-binding.test.mjs 的手写 preflight
//   5. sc-preflight 夹具把 node_modules/.bin 替身 commit 进 HEAD（让测试环境跑得通、真实仓跑不通）
// 本轮修复：三 SC 的声明并集覆盖全部 4 gate + 10 hardening；cell() 对 gate/hardening 格
// 同样按声明挑 SC，不再存在「任意同 task SC 能填满」的默认形态。

/** 本测试夹具的三条 SC（faces 并集 = A..G；gates/hardening_classes 并集 = 全部 14 维度） */
function testScs() {
  return [
    { id: 'SC-1', priority_id: TASK, kind: 'fix', granularity: 'anchor', change: 'c1', holds: 'h1',
      verify: { cmd: 'echo', args: ['ok'] }, expect: 'ok',
      anchor_paths: ['src/app/App.tsx', 'src/lib/util.ts'], faces: ['A', 'B', 'C'],
      gates: ['format-gate', 'rule-compliance'], hardening_classes: [2, 3, 4, 5, 6],
      predicted_invariant: 'iv1', predicted_primary_face: 'A' },
    { id: 'SC-2', priority_id: TASK, kind: 'verify', granularity: 'assertion', change: 'c2', holds: 'h2',
      verify: { cmd: 'echo', args: ['ok'] }, expect: 'ok',
      anchor_paths: ['src/canvas/Canvas.tsx'], faces: ['A', 'C'],
      gates: ['security-privacy-gate', 'product-arch-gate'], hardening_classes: [7, 8, 9, 10] },
    { id: 'SC-3', priority_id: TASK, kind: 'fix', granularity: 'anchor', change: 'c3', holds: 'h3',
      verify: { cmd: 'echo', args: ['ok'] }, expect: 'ok',
      anchor_paths: ['src/lib/format.ts', 'src/server/routes.ts'], faces: ['D', 'E', 'F', 'G'],
      gates: [], hardening_classes: [1],
      predicted_invariant: 'iv3', predicted_primary_face: 'D' },
  ];
}

function baseManifest() {
  return {
    schema_version: 'v1',
    slug: 'coverage-matrix-test',
    goal: 'test goal',
    context_refs: [],
    priorities: [{ id: TASK, title: 't1', why: 'w', pr_split: { suggested_prs: 1, functional_pr: true } }],
    scs: testScs(),
    coverage: [],
  };
}

/** 声明了指定维度的 SC id 清单（格 sc_ids 的诚实默认值；field ∈ {faces, gates, hardening_classes}） */
function declaringScIds(dim, field = 'faces') {
  return testScs()
    .filter((s) => (s[field] ?? []).map(String).includes(String(dim)))
    .map((s) => s.id);
}

function cell(kind, dim, status, extra = {}) {
  // face/gate/hardening 格默认引用声明了该维度的 SC（P0-B 族诚实基线）——不存在
  // 「任意同 task SC 填满」的默认形态（第六处同形态，见上方注释）
  const field = kind === 'face' ? 'faces' : kind === 'gate' ? 'gates' : 'hardening_classes';
  const scIds = declaringScIds(dim, field);
  return { task_id: TASK, dimension_kind: kind, dimension_id: dim, status, sc_ids: scIds, evidence: 'e', ...extra };
}

// 21 格全覆盖（维度集从 authority 动态取）；B cell 用传入的 ui_prediction 版
function fullCoverage(bCell) {
  const cells = [];
  for (const f of A.FACES) {
    cells.push(f === 'B' ? bCell : cell('face', f, 'covered'));
  }
  for (const g of A.GATES) cells.push(cell('gate', g, 'covered'));
  for (const h of A.HARDENING_CLASSES) cells.push(cell('hardening', String(h), 'covered'));
  return cells;
}

// B cell 的诚实值：input_paths/registry_path 用真实派生逻辑，三输出用真实 matcher 现跑
function honestBCell(manifest, mutate) {
  const derived = deriveInputPaths(manifest, TASK);
  const { path, registry } = A.resolveUiRegistry(getRepo());
  const run = A.matchUiPaths(registry, derived);
  const up = {
    input_paths: derived,
    registry_path: path,
    config_hash: run.config_hash,
    touches_ui: run.touches_ui,
    matched_paths: run.matched_paths,
  };
  if (mutate) mutate(up, run);
  return cell('face', 'B', 'covered', { ui_prediction: up });
}

function violationsOf(manifest, bCell) {
  const m = { ...manifest, coverage: fullCoverage(bCell) };
  return checkCoverage(m, { authority: A, getRepo });
}

function hasViolation(violations, code, dim, kind = 'face') {
  return violations.some(
    (v) => v.error_code === code && v.task_id === TASK && v.dimension_kind === kind && v.dimension_id === dim
  );
}

// CLI 冒烟：跑静态 fixture，返回 {code, stderr}；cwd 可换（如无 origin 的临时仓）
function runCli(fixtureRel, cwd = repoDir) {
  try {
    execFileSync(
      'node',
      ['scripts/coverage-matrix.mjs', '--manifest', join('tests', 'fixtures', 'coverage', fixtureRel), '--cwd', cwd],
      { cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status, stderr: e.stderr ?? '' };
  }
}

// ── t1 缺格 → COVERAGE_CELL_MISSING ──

test('t1: 缺格 → COVERAGE_CELL_MISSING（JS 构造）', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).filter((c) => !(c.dimension_kind === 'face' && c.dimension_id === 'D')) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.COVERAGE_CELL_MISSING, 'D'), JSON.stringify(violations));
});

test('t1-cli: 静态缺格 fixture → exit 2 且 stderr 点名该格', () => {
  const r = runCli('missing-cell.json');
  assert.equal(r.code, 2, `expected exit 2, stderr=${r.stderr}`);
  assert.match(r.stderr, /COVERAGE_CELL_MISSING/);
  assert.match(r.stderr, /P1 face D/); // task_id + dimension_kind + dimension_id 点名
});

// ── t2 单任务全 n_a → TASK_ALL_NA ──

test('t2: A/C/F 三面全 n_a → TASK_ALL_NA', () => {
  const manifest = baseManifest();
  const bCell = honestBCell(manifest);
  const nACell = (f) => cell('face', f, 'n_a', { reason_code: 'no_claim_made' });
  const m = { ...manifest, coverage: fullCoverage(bCell).map((c) => (['A', 'C', 'F'].includes(c.dimension_id) ? nACell(c.dimension_id) : c)) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.TASK_ALL_NA, 'A/C/F'), JSON.stringify(violations));
});

// ── t3 n_a 缺 reason_code / evidence → NA_MISSING_REASON_CODE ──

test('t3a: n_a 缺 reason_code → NA_MISSING_REASON_CODE', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) => (c.dimension_kind === 'face' && c.dimension_id === 'D' ? { ...c, status: 'n_a', reason_code: undefined } : c)) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.NA_MISSING_REASON_CODE, 'D'), JSON.stringify(violations));
});

test('t3b: n_a 缺 evidence → NA_MISSING_REASON_CODE', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) => (c.dimension_kind === 'face' && c.dimension_id === 'D' ? { ...c, status: 'n_a', reason_code: 'no_claim_made', evidence: '   ' } : c)) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.NA_MISSING_REASON_CODE, 'D'), JSON.stringify(violations));
});

test('t3c: reason_code 自由文本不算 reason_code → NA_MISSING_REASON_CODE', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) => (c.dimension_kind === 'face' && c.dimension_id === 'D' ? { ...c, status: 'n_a', reason_code: '本任务没有文档改动' } : c)) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.NA_MISSING_REASON_CODE, 'D'), JSON.stringify(violations));
  // 枚举完整性：导出的 REASON_CODES 至少含计划指定的 8 个
  for (const rc of ['no_ui_paths', 'no_doc_surface', 'no_new_mechanism', 'no_concurrency', 'no_security_surface', 'no_test_surface', 'no_claim_made', 'no_scope_risk']) {
    assert.ok(REASON_CODES.includes(rc), `REASON_CODES 缺 ${rc}`);
  }
});

// ── t4 B 维度缺 ui_prediction 结构对象 → B_DIM_MISSING_UIPRED ──

test('t4: B 维度只填 evidence 自由文本、无 ui_prediction → B_DIM_MISSING_UIPRED', () => {
  const manifest = baseManifest();
  const bCell = cell('face', 'B', 'covered', { evidence: 'B 面已分析，无 UI 风险' }); // 无 ui_prediction
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.B_DIM_MISSING_UIPRED, 'B'), JSON.stringify(violations));
});

// ── t5 B 维度 ui_prediction 与派生值/现跑不符 → B_DIM_UIPRED_MISMATCH ──

test('t5a: 旧 config_hash（registry 已变）→ B_DIM_UIPRED_MISMATCH', () => {
  const manifest = baseManifest();
  const bCell = honestBCell(manifest, (up) => { up.config_hash = '0'.repeat(64); });
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.B_DIM_UIPRED_MISMATCH, 'B'), JSON.stringify(violations));
});

test('t5b: matched_paths 与现跑不一致 → B_DIM_UIPRED_MISMATCH', () => {
  const manifest = baseManifest();
  const bCell = honestBCell(manifest, (up) => { up.matched_paths = ['src/app/Wrong.tsx']; });
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.B_DIM_UIPRED_MISMATCH, 'B'), JSON.stringify(violations));
});

test('t5c: anchor_paths 含 UI 路径但 input_paths 漏掉它（样本被裁剪）→ B_DIM_UIPRED_MISMATCH', () => {
  const manifest = baseManifest();
  // SC-1 的 anchor_paths 含 UI 路径 src/app/App.tsx；cell 落盘 input_paths 只给非 UI 的 src/lib/util.ts
  const bCell = honestBCell(manifest, (up) => { up.input_paths = ['src/lib/util.ts']; });
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.B_DIM_UIPRED_MISMATCH, 'B'), JSON.stringify(violations));
});

// ── t6 n_a_predicted 域限 → NA_PREDICTED_OUT_OF_DOMAIN ──

test('t6: n_a_predicted 出现在非 B 维度 → NA_PREDICTED_OUT_OF_DOMAIN', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) => (c.dimension_kind === 'face' && c.dimension_id === 'C' ? { ...c, status: 'n_a_predicted', reason_code: 'no_ui_paths' } : c)) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.NA_PREDICTED_OUT_OF_DOMAIN, 'C'), JSON.stringify(violations));
});

// ── t7 registry_path 换成非权威 registry → B_DIM_UIPRED_MISMATCH ──

test('t7: registry_path 换成非权威 registry → B_DIM_UIPRED_MISMATCH', () => {
  const manifest = baseManifest();
  // 权威口径是本仓（mivo）registry；落盘 cindy registry 的路径 = 非权威
  const cindyPath = A.resolveUiRegistry('makecindy/cindy').path;
  assert.notEqual(cindyPath, registryPath, '测试前提：cindy registry ≠ mivo registry');
  const bCell = honestBCell(manifest, (up) => { up.registry_path = cindyPath; });
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.ok(hasViolation(violations, ERROR_CODES.B_DIM_UIPRED_MISMATCH, 'B'), JSON.stringify(violations));
});

// ── P0-A / P0-B 反向变异（隔离判据：每支「恰好等于」预期那一条，防串码掩盖）──

test('P0-A m1: B=n_a 且派生 touches_ui=true → 恰好 B_DIM_NA_CONTRADICTS_UI', () => {
  const manifest = baseManifest();
  // 前提：本夹具默认 anchor（App/Canvas 为真实 UI 文件）派生 touches_ui=true——
  // 真实 matcher 现跑验证，防 registry 演进后静默退化
  const derived = deriveInputPaths(manifest, TASK);
  const { registry } = A.resolveUiRegistry(getRepo());
  const run = A.matchUiPaths(registry, derived);
  assert.equal(run.touches_ui, true, '前提：默认 anchor 派生必须 touches_ui=true');
  const bCell = cell('face', 'B', 'n_a', { reason_code: 'no_ui_paths', evidence: '声称无 UI 路径' });
  const violations = violationsOf(manifest, bCell);
  // 精确等于（不是包含）：数量 1 + 四字段逐项相等 + message 与实现透传的现跑结果一致
  assert.deepEqual(violations, [{
    task_id: TASK,
    dimension_kind: 'face',
    dimension_id: 'B',
    error_code: ERROR_CODES.B_DIM_NA_CONTRADICTS_UI,
    message: `B 维度标 n_a 但派生 touches_ui=true（matched=${JSON.stringify(run.matched_paths)}），n_a 与真实 UI 命中矛盾`,
  }], JSON.stringify(violations));
});

test('P0-A m2: B=n_a 且 anchor 全非 UI（派生 touches_ui=false）→ 对照组零违规', () => {
  const manifest = baseManifest();
  // 全部 SC 的 anchor_paths 换成已实测非 UI 的路径（util.ts / server/index.ts 在
  // fixtures/coverage 数据里均未被 matcher 命中）
  for (const s of manifest.scs) s.anchor_paths = ['src/lib/util.ts', 'src/server/index.ts'];
  const derived = deriveInputPaths(manifest, TASK);
  const { registry } = A.resolveUiRegistry(getRepo());
  assert.equal(A.matchUiPaths(registry, derived).touches_ui, false, '前提：全非 UI anchor 派生必须 touches_ui=false');
  const bCell = cell('face', 'B', 'n_a', { reason_code: 'no_ui_paths', evidence: '无 UI 路径可判' });
  const violations = violationsOf(manifest, bCell);
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

test('P0-B m3: face D 格唯一 sc_id 指向 faces 不含 D 的 SC → 恰好 CELL_FACE_NOT_DECLARED', () => {
  const manifest = baseManifest();
  // SC-1 faces=[A,B,C] 不含 D；把 D 格的 sc_ids 换成 ['SC-1']（旧基线「默认全填 SC-1」的错误形态）
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    c.dimension_kind === 'face' && c.dimension_id === 'D' ? { ...c, sc_ids: ['SC-1'] } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.deepEqual(violations, [{
    task_id: TASK,
    dimension_kind: 'face',
    dimension_id: 'D',
    error_code: ERROR_CODES.CELL_FACE_NOT_DECLARED,
    message: 'face D 格 status=covered 但 sc_ids(["SC-1"]) 中无任一 SC 的 faces 声明包含 D',
  }], JSON.stringify(violations));
});

test('P0-B m4: face D 格指向 faces 含 D 的 SC → 对照组零违规', () => {
  const manifest = baseManifest();
  // SC-3 faces=[D,E,F,G] 声明包含 D；同格改指 SC-3 → 绑定成立
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    c.dimension_kind === 'face' && c.dimension_id === 'D' ? { ...c, sc_ids: ['SC-3'] } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

// ── P0-B 族 2026-08-09：gate / hardening 绑定（反向变异，断言「恰好等于」而非「包含」）──
// 前提断言把「该 SC 未声明该维度」写死，防声明演进后静默退化。

test('P0-B m5: gate format-gate 格 sc_ids 指向未声明该 gate 的 SC → 恰好 CELL_GATE_NOT_DECLARED', () => {
  const manifest = baseManifest();
  // SC-2 gates=[security-privacy-gate, product-arch-gate] 不含 format-gate；旧基线「默认填
  // SC-1」的错误形态现在拿 SC-2 演示——任意同 task SC 填 gate 格必须被拒
  assert.ok(!testScs().find((s) => s.id === 'SC-2').gates.includes('format-gate'), 'm5 前提：SC-2 未声明 format-gate');
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    c.dimension_kind === 'gate' && c.dimension_id === 'format-gate' ? { ...c, sc_ids: ['SC-2'] } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.deepEqual(violations, [{
    task_id: TASK,
    dimension_kind: 'gate',
    dimension_id: 'format-gate',
    error_code: ERROR_CODES.CELL_GATE_NOT_DECLARED,
    message: 'gate format-gate 格 status=covered 但 sc_ids(["SC-2"]) 中无任一 SC 的 gates 声明包含 format-gate',
  }], JSON.stringify(violations));
});

test('P0-B m6: hardening 2 格 sc_ids 指向未声明该类号的 SC → 恰好 CELL_HARDENING_NOT_DECLARED', () => {
  const manifest = baseManifest();
  // SC-3 hardening_classes=[1] 不含 2
  assert.deepEqual(testScs().find((s) => s.id === 'SC-3').hardening_classes, [1], 'm6 前提：SC-3 只声明类 1');
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    c.dimension_kind === 'hardening' && c.dimension_id === '2' ? { ...c, sc_ids: ['SC-3'] } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.deepEqual(violations, [{
    task_id: TASK,
    dimension_kind: 'hardening',
    dimension_id: '2',
    error_code: ERROR_CODES.CELL_HARDENING_NOT_DECLARED,
    message: 'hardening 2 格 status=covered 但 sc_ids(["SC-3"]) 中无任一 SC 的 hardening_classes 声明包含 2',
  }], JSON.stringify(violations));
});

test('P0-B m7: gate/hardening 格指向声明了该维度的 SC → 对照组零违规', () => {
  const manifest = baseManifest();
  // SC-1 声明了 format-gate 与 hardening 类 2；同格改指 SC-1 → 绑定成立
  assert.ok(testScs().find((s) => s.id === 'SC-1').gates.includes('format-gate'), 'm7 前提：SC-1 声明 format-gate');
  assert.ok(testScs().find((s) => s.id === 'SC-1').hardening_classes.includes(2), 'm7 前提：SC-1 声明类 2');
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    (c.dimension_kind === 'gate' && c.dimension_id === 'format-gate') ||
    (c.dimension_kind === 'hardening' && c.dimension_id === '2') ? { ...c, sc_ids: ['SC-1'] } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

test('P0-B m8: 该格标 n_a + 合法 reason_code → 对照组必须通过（不是一律拒）', () => {
  const manifest = baseManifest();
  // n_a 不触发绑定判据（仅 covered / n_a_predicted）；断言「合法 n_a 永远放行」，
  // 防未来把判据误扩成「凡 n_a 即红」
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)).map((c) =>
    c.dimension_kind === 'gate' && c.dimension_id === 'format-gate' ? {
      task_id: TASK, dimension_kind: 'gate', dimension_id: 'format-gate',
      status: 'n_a', sc_ids: [], reason_code: 'no_claim_made', evidence: '本 task 对该闸不作声称',
    } : c) };
  const violations = checkCoverage(m, { authority: A, getRepo });
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

// ── t8 齐全 fixture → exit 0 ──

test('t8-cli: 齐全 fixture → exit 0', () => {
  const r = runCli('complete.json');
  assert.equal(r.code, 0, `expected exit 0, stderr=${r.stderr}`);
});

test('t8-unit: 动态齐全 manifest → 零违规', () => {
  const manifest = baseManifest();
  const violations = violationsOf(manifest, honestBCell(manifest));
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

// ── t9 B_DIM_REGISTRY_UNAVAILABLE：repo→registry 固定映射不可用时 fail-closed（F35）──
// 定义在 coverage-matrix.mjs:63 / :199——getRepo 惰性求值抛错（无 origin / 非 git 仓）→
// 相关 B cell 记 B_DIM_REGISTRY_UNAVAILABLE 并 continue（禁回落任意路径、不猜 registry）。

test('t9a-unit: getRepo 抛错 → 仅 B_DIM_REGISTRY_UNAVAILABLE 一条（精确断言，防串码）', () => {
  const manifest = baseManifest();
  const m = { ...manifest, coverage: fullCoverage(honestBCell(manifest)) };
  const violations = checkCoverage(m, {
    authority: A,
    getRepo: () => { throw new Error("No such remote 'origin'"); },
  });
  // 精确等于目标 code：数量 1 + 对象四字段逐项相等（不是"包含"），串成别的 code 即红
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].task_id, TASK, JSON.stringify(violations));
  assert.equal(violations[0].dimension_kind, 'face', JSON.stringify(violations));
  assert.equal(violations[0].dimension_id, 'B', JSON.stringify(violations));
  assert.equal(violations[0].error_code, ERROR_CODES.B_DIM_REGISTRY_UNAVAILABLE, JSON.stringify(violations));
  // message 透传 getRepo 抛错原文，证明走的是 repo 不可用路径而非别的判据
  assert.match(violations[0].message, /No such remote/, `message 应透传抛错信息: ${violations[0].message}`);
});

test('t9b-cli: 无 origin 的临时 git 仓 → exit 2 且 stderr 中 error code 唯一（B_DIM_REGISTRY_UNAVAILABLE）', () => {
  const noOrigin = mkdtempSync(join(tmpdir(), 'tp-cov-noorigin-'));
  execFileSync('git', ['init', '-q', noOrigin]); // 故意不添加 origin
  try {
    const r = runCli('complete.json', noOrigin);
    assert.equal(r.code, 2, `expected exit 2, stderr=${r.stderr}`);
    // git remote get-url 失败行透传到 stderr（fail-closed 的可见证据）
    assert.match(r.stderr, /No such remote 'origin'/, `stderr 应含 git 报错行: ${r.stderr}`);
    assert.match(r.stderr, /P1 face B /, `stderr 应点名违规格: ${r.stderr}`);
    // code 唯一性：只从违规行（task_id face B [<CODE>]，F3 方括号形态）取 [CODE]，行首 task_id 不算
    const codes = r.stderr
      .split('\n')
      .filter((l) => /^P\d+ face B /.test(l))
      .map((l) => { const m = l.match(/\[([A-Z][A-Z0-9_]+)\]/); return m ? m[1] : l.trim().split(/\s+/).pop(); });
    assert.ok(codes.length > 0, `stderr 应含至少一条违规行: ${r.stderr}`);
    assert.ok(
      codes.every((c) => c === ERROR_CODES.B_DIM_REGISTRY_UNAVAILABLE),
      `违规行出现非目标 error code: ${JSON.stringify(codes)} stderr=${r.stderr}`
    );
  } finally {
    rmSync(noOrigin, { recursive: true, force: true });
  }
});
