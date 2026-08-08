// tests/fixtures/joint/generate-complete.mjs — joint fixture 一次性生成器（SC-7 对照组）。
//
// 用途：生成 tests/fixtures/joint/complete.json —— 同时通过 manifest-validate(--stage=final)
// 与 coverage-matrix 两闸的「齐全 fixture」，作为 SC-7 反向变异族的基线对照组。
// 本生成器不写任何判据逻辑：B 维度诚实值全部用**真实 authority** 现跑产出
// （resolveUiRegistry + matchUiPaths + deriveInputPaths），fixture 的合法性依赖被测实现
// 自身的派生逻辑——实现派生错、诚实 fixture 就会当场变红（「派生不采信」判据的测试价值）。
//
// 用法：node tests/fixtures/joint/generate-complete.mjs [--out <路径，缺省 ./complete.json>]
// 生成后自校验：manifestCoreHash 不动点 + 双闸重跑（在临时 git 仓内跑 coverage-matrix）。
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadAuthority } from '../../../scripts/lib/authority.mjs';
import { canonicalRepo } from '../../../scripts/lib/repo-identity.mjs';
import { manifestCoreHash } from '../../../scripts/lib/hashing.mjs';
import { deriveInputPaths } from '../../../scripts/coverage-matrix.mjs';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CANONICAL_REPO = 'xindong/mivo-canvas'; // 与 tests 的临时 git repo origin 一致

// face 无声明时的结构化 reason_code（语义：D=文档一致性、F=范围合规、G=声称核实；
// E 面无权威定义，用 no_claim_made 兜底——记入待办，定义归 pr-autopilot 权威侧）
const NA_FACE_REASON = {
  D: 'no_doc_surface',
  F: 'no_scope_risk',
};

// ── SC 正文（final 阶段：每个 SC 必带 preflight）──
// 2026-08-09（同形态第六处）：SC 新增可选声明字段 gates / hardening_classes，值域 = authority
// GATES / HARDENING_CLASSES。与前五处同形态（测试作者为省一个依赖或图一次方便，写出缺陷形态
// 并固化成基线）：
//   1. final-gate.test.mjs 的 B 面 n_a（注释写着「免 git/registry 依赖」）
//   2. coverage-matrix.test.mjs 的 cell() 默认全填 SC-1
//   3. joint/complete.json 的 8 个未声明 face 格
//   4. dispatch-binding.test.mjs 的手写 preflight
//   5. sc-preflight 夹具把 node_modules/.bin 替身 commit 进 HEAD（让测试环境跑得通、真实仓跑不通）
// 此前 gate/hardening 14 格无绑定，生成器把格填 taskScs（任意同 task SC）即可双闸全绿；
// 现在按声明挑 SC：P1 由 SC-1（format/rule-compliance + 类 2-10）与 SC-2（security/product-arch）
// 并集覆盖全部 4 闸 + 9 类（类 1 保持 n_a，reverse-mutation M3 靶点）；P2 由 SC-3 全量声明。
const sc1 = {
  id: 'SC-1', priority_id: 'P1', kind: 'fix', granularity: 'anchor',
  change: '把拖入画布的图片接入 AI 读取链路', holds: '拖入的图片可被 AI 读取且不再被吞',
  verify: { cmd: 'node', args: ['--test'] }, expect: 'pass',
  anchor_paths: ['src/app/App.tsx', 'src/lib/util.ts'], faces: ['A', 'B', 'C'],
  gates: ['format-gate', 'rule-compliance'], hardening_classes: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  predicted_invariant: '拖入图片不被吞', predicted_primary_face: 'B',
  preflight: { status: 'green_warn', note: '命令存在且实跑绿', disposition: '接受' },
};
const sc2 = {
  id: 'SC-2', priority_id: 'P1', kind: 'verify', granularity: 'assertion',
  change: '验证图片读取链路端到端', holds: '链路结果稳定',
  verify: { cmd: 'npm', args: ['test'] }, expect: 'pass',
  anchor_paths: ['src/canvas/Canvas.tsx', 'src/server/index.ts'], faces: ['A', 'C'],
  gates: ['security-privacy-gate', 'product-arch-gate'], hardening_classes: [],
  preflight: { status: 'exists_not_run', note: '命令存在未实跑' },
};
const sc3 = {
  id: 'SC-3', priority_id: 'P2', kind: 'fix', granularity: 'anchor',
  change: '修复渲染器对图片资源的引用泄漏', holds: '渲染器资源引用释放',
  verify: { cmd: 'node', args: ['--test'] }, expect: 'pass',
  anchor_paths: ['src/canvas/Canvas.tsx', 'src/render/useLeaferSpikeRenderer.ts'], faces: ['B', 'C', 'D'],
  gates: ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'],
  hardening_classes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  predicted_invariant: '渲染器不泄漏', predicted_primary_face: 'B',
  preflight: { status: 'green_warn', note: '命令存在且实跑绿', disposition: '接受' },
};

function buildManifest(A, registryInfo) {
  const priorities = [
    { id: 'P1', title: '图片接入 AI 读取', why: 'owner 拍板优先级', pr_split: { suggested_prs: 2, functional_pr: true } },
    { id: 'P2', title: '渲染器资源泄漏修复', why: '渲染稳定性', pr_split: { suggested_prs: 1, functional_pr: false } },
  ];
  const scs = [sc1, sc2, sc3];

  // ── coverage 矩阵：每 task × 全部维度（维度集从 authority 动态取，不硬编码 21）──
  // P0-B 族（coverage-matrix 独占判据 CELL_FACE/GATE/HARDENING_NOT_DECLARED）：covered 格必须由
  // 「声明了该维度」的 SC 支持——本生成器按 declaring SC 挑 sc_ids；face 无任一 SC 声明 → n_a
  // （结构化 reason_code + evidence）。历史教训：曾把所有 face 格填 taskScs（P1 的 SC-1/SC-2
  // 只声明 A/B/C、A/C，P2 的 SC-3 只声明 B/C/D）→ 8 格未声明即双闸 exit 0；gate/hardening 14
  // 格更无绑定，任意同 task SC 填满即绿——正是该判据族要拦的「一条 SC 填满全矩阵」绕过。
  const coveredCell = (taskId, kind, dim, scIds) => ({
    task_id: taskId, dimension_kind: kind, dimension_id: dim, status: 'covered', sc_ids: scIds, evidence: 'e',
  });
  const naCell = (taskId, kind, dim, reasonCode, evidence) => ({
    task_id: taskId, dimension_kind: kind, dimension_id: dim, status: 'n_a', sc_ids: [],
    reason_code: reasonCode, evidence,
  });
  const naFaceCell = (taskId, dim) => naCell(taskId, 'face', dim,
    NA_FACE_REASON[String(dim)] ?? 'no_claim_made',
    `本 task 无 SC 声明 face ${dim}（${NA_FACE_REASON[String(dim)] ?? 'no_claim_made'}）`);
  // 声明字段按维度 kind 映射（face→faces / gate→gates / hardening→hardening_classes）
  const declField = { face: 'faces', gate: 'gates', hardening: 'hardening_classes' };
  const declaringScIds = (taskId, kind, dim) =>
    scs.filter((s) => s.priority_id === taskId && (s[declField[kind]] ?? []).map(String).includes(String(dim)))
      .map((s) => s.id);
  const cells = [];
  for (const taskId of ['P1', 'P2']) {
    for (const f of A.FACES) {
      const decl = declaringScIds(taskId, 'face', f);
      cells.push(decl.length > 0 ? coveredCell(taskId, 'face', f, decl) : naFaceCell(taskId, f));
    }
    for (const g of A.GATES) {
      const decl = declaringScIds(taskId, 'gate', g);
      if (decl.length === 0) throw new Error(`生成失败：task ${taskId} 无任一 SC 声明 gate ${g}（covered 格必须有声明支持）`);
      cells.push(coveredCell(taskId, 'gate', g, decl));
    }
    for (const h of A.HARDENING_CLASSES) {
      // P1 hardening 类 1：保持合法 n_a（reverse-mutation M3 的靶点：删其 reason_code 即触发
      // NA_MISSING_REASON_CODE），不要求 SC 声明（n_a 不触发绑定判据）
      if (taskId === 'P1' && String(h) === '1') {
        cells.push(naCell(taskId, 'hardening', String(h), 'no_new_mechanism', '不引入新机制/新状态机'));
        continue;
      }
      const decl = declaringScIds(taskId, 'hardening', h);
      if (decl.length === 0) throw new Error(`生成失败：task ${taskId} 无任一 SC 声明 hardening 类 ${h}（covered 格必须有声明支持）`);
      cells.push(coveredCell(taskId, 'hardening', String(h), decl));
    }
  }

  const manifest = {
    schema_version: '1.0.0',
    slug: 'joint-complete',
    goal: '双闸全绿基线 fixture（SC-7 反向变异族对照组）',
    context_refs: [],
    priorities,
    scs,
    coverage: cells,
    waves: [{ wave: 1, groups: [{ group_id: 'g1', sc_ids: ['SC-1', 'SC-2', 'SC-3'], worker_count: 2 }] }],
    dispatch: {
      capacity: A.capacity,
      packets: [{
        group_id: 'g1',
        scs_inline: [sc1, sc2, sc3], // 与顶层 scs 逐字一致（同一对象）
        allowed_paths: ['src/'],
        forbidden: ['src/secret.ts'],
        verify_cmds: ['cd src && node --test'],
        submit_format: '{status: PASS|BLOCKED, sc_results: [{sc_id, status, evidence}], changed_files: [...], residual_risks: [...]}',
        instruction: '用 goal skill 执行本派工包',
        needs_three_review: true,
        manifest_core_hash: '', // 占位，下面统一回填
      }],
    },
  };

  // ── B 维度诚实值：由真实 authority 现跑（派生不采信——生成器不手算）──
  const { path: registryPath, registry } = registryInfo;
  for (const taskId of ['P1', 'P2']) {
    const derived = deriveInputPaths(manifest, taskId);
    const run = A.matchUiPaths(registry, derived);
    const bIdx = manifest.coverage.findIndex(
      (c) => c.task_id === taskId && c.dimension_kind === 'face' && String(c.dimension_id) === 'B'
    );
    manifest.coverage[bIdx].ui_prediction = {
      input_paths: derived,
      registry_path: registryPath,
      config_hash: run.config_hash,
      touches_ui: run.touches_ui,
      matched_paths: run.matched_paths,
    };
  }

  // （P1 hardening 类 1 的合法 n_a 格已在上面循环内生成——reverse-mutation M3 靶点，
  // 不再有第二处覆盖段，防双写漂移）

  // ── manifest_core_hash：算出来回填（顶层 + packet），回填后重算必须不变（不动点）──
  const hash = manifestCoreHash(manifest);
  manifest.manifest_core_hash = hash;
  manifest.dispatch.packets[0].manifest_core_hash = hash;
  if (manifestCoreHash(manifest) !== hash) {
    throw new Error('生成失败：manifestCoreHash 回填后重算不等（非不动点）');
  }
  return manifest;
}

// ── 生成后自校验：双闸全绿（coverage-matrix 在临时 git 仓内跑）──
function verifyBothGates(manifest, outPath) {
  const repoDir = mkdtempSync(join(tmpdir(), 'tp-joint-gen-'));
  try {
    execFileSync('git', ['init', '-q', repoDir]);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', `git@github.com:${CANONICAL_REPO}.git`]);
    execFileSync('node', ['scripts/manifest-validate.mjs', '--manifest', outPath, '--stage=final'], {
      cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('node', ['scripts/coverage-matrix.mjs', '--manifest', outPath, '--cwd', repoDir], {
      cwd: SKILL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(dirname(fileURLToPath(import.meta.url)), 'complete.json');
  const A = await loadAuthority();
  const registryInfo = A.resolveUiRegistry(CANONICAL_REPO);
  const manifest = buildManifest(A, registryInfo);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  verifyBothGates(manifest, outPath);
  console.log(`joint fixture 生成 + 双闸自校验通过: ${outPath}`);
  console.log(`  维度: FACES=${A.FACES.length} GATES=${A.GATES.length} HARDENING=${A.HARDENING_CLASSES.length}`);
  console.log(`  P1 input_paths: ${JSON.stringify(deriveInputPaths(manifest, 'P1'))}`);
  console.log(`  P2 input_paths: ${JSON.stringify(deriveInputPaths(manifest, 'P2'))}`);
}

main().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
