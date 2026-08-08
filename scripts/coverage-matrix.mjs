#!/usr/bin/env node
// scripts/coverage-matrix.mjs — 七面反推闸（全覆盖类判据的**独占 owner**；计划 SC-2 / 核心机制 C、E / F34 / F35）。
//
// 独占判据（manifest-validate **不判**；schema 刻意把 reason_code/evidence/ui_prediction 留作可选，
// 必填性由此闸独占执行，保证判据所有权单一——见计划「核心机制 C 判据所有权表」）：
//   1. COVERAGE_CELL_MISSING      任务 × 维度矩阵全覆盖（缺格）
//   2. TASK_ALL_NA                单任务全 n_a（A/C/F 三面至少一面必须 covered）
//   3. NA_MISSING_REASON_CODE     n_a / n_a_predicted 缺 reason_code（结构化枚举）或缺 evidence
//   4. B_DIM_MISSING_UIPRED       B 维度缺 ui_prediction 结构对象（只填自由文本 evidence 不算）
//   5. B_DIM_UIPRED_MISMATCH      B 维度 ui_prediction 与派生值 / 现跑结果任一不符（F34/F35）
//   6. NA_PREDICTED_OUT_OF_DOMAIN n_a_predicted 出现在非 B 维度
//   7. B_DIM_REGISTRY_UNAVAILABLE 该 repo 无权威 registry 映射（fail-closed 报缺配置，禁回落任意路径；
//                                 计划「依赖与前置条件」：映射缺失 → B 维度 fail-closed 报缺配置）
//   8. B_DIM_NA_CONTRADICTS_UI   B 维度标 n_a 但派生 touches_ui=true（P0-A：n_a 不得绕过 matcher，
//                                 必须由派生「无 UI 命中」支持）
//   9. CELL_FACE_NOT_DECLARED    face 维度 covered / n_a_predicted 格的 sc_ids 中无任一 SC 的
//                                 faces 声明包含该 dimension_id（P0-B：一条 UI SC 不得填满全矩阵）
//   10. CELL_GATE_NOT_DECLARED   gate 维度 covered / n_a_predicted 格的 sc_ids 中无任一 SC 的
//                                 gates 声明包含该 gate id（2026-08-09：与 9 同族，闭环 P0-B——
//                                 此前任意同 task SC 可把 4 闸格全填 covered）
//   11. CELL_HARDENING_NOT_DECLARED hardening 维度 covered / n_a_predicted 格的 sc_ids 中无任一
//                                 SC 的 hardening_classes 声明包含该类号（同 10）
//
// 不判（manifest-validate 独占，假定已过；final-gate 定序会保证先后）：
//   schema 形状 / 枚举合法性 / cell 唯一性 / 引用完整性（sc_ids 存在且同任务）/ 路径安全。
//   多判会破坏反向变异（SC-7）的 not_run 预测——结构红应记 not_run，不能由本闸制造第二个红。
//
// 核心机制 E（派生，不采信——总纪律：被审对象不得选择自己的证据样本与判据配置）：
//   - input_paths 由本闸从该 task 引用的**全部 SC 的 anchor_paths** 派生（并集 → POSIX 规范化 →
//     去重 → 排序）。cell 若落盘此值，它只是冗余副本，必须与派生值**逐字相等**，不等即拒
//     （禁止裁剪样本）。
//   - registry_path 由本闸经 authority.resolveUiRegistry(canonicalRepo) 派生。cell 落盘值必须等于
//     派生值，不等即拒（禁任意路径）。
//   - 然后用**派生的** input_paths + registry 现场调 authority.matchUiPaths(...)，把
//     config_hash / touches_ui / matched_paths 三个输出**逐字段**与 cell 声明值比对，任一不符 → 拒。
//   - canonicalRepo 经 lib/repo-identity.mjs 的 canonicalRepo({cwd}) 离线派生（不依赖 gh）。
//   - P0-A 修复：B 维度**任何 status**（含 n_a）都执行上述派生 + 现跑——n_a 只有
//     派生 touches_ui=false 才合法；touches_ui=true 而标 n_a → B_DIM_NA_CONTRADICTS_UI。
//     （旧分支条件 `status === 'covered' || status === 'n_a_predicted'` 让 n_a 完全跳过 matcher，
//     等于把「是否真无 UI 路径」交给被审对象自报——与核心机制 E 同根。）
//
// 残余（如实声明，不宣称语义完备）：机器能证「样本集 == 该 task 全部 SC 的 anchor_paths 确定性并集」
// 「registry 是权威那份」「声明结果 == 该输入下的真实 matcher 结果」三件事；**仅剩**
// 「anchor_paths 本身是否列全该任务真会碰的文件」不可机器判——这是真正的语义问题，
// 由 Phase 4 对抗质询兜底（T1，计划核心机制 E 残余段）。
//
// 退出码：无违规 exit 0；任何违规 exit 2，stderr 输出违规格清单（每行：
//   <task_id> <dimension_kind> <dimension_id> [<error_code>]）。
// [<error_code>] 方括号形态（F3，2026-08-09）：final-gate 的 runSubprocess 取第一个 [CODE]
// 转述 owner 原码——此前无方括号时 final-gate 只能记 generic COVERAGE_MATRIX_FAIL，
// 消费者无法精确回哪个 Phase 修（违反核心机制 C 的 error_code 转述契约）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAuthority } from './lib/authority.mjs';
import { canonicalRepo } from './lib/repo-identity.mjs';

// ── reason_code 结构化枚举（本闸定义并导出；自由文本不算 reason_code）──
// 覆盖 n_a 的常见合法性理由；扩展由本 skill 自进化台账驱动（计划 SC-2③）。
export const REASON_CODES = [
  'no_ui_paths',            // 该 task 无 UI 面路径可判
  'no_doc_surface',         // 无文档改动面
  'no_new_mechanism',       // 不引入新机制/新状态机
  'no_concurrency',         // 无并发/共享状态改动
  'no_security_surface',    // 无安全边界改动
  'no_test_surface',        // 无测试面（纯配置/迁移类）
  'no_claim_made',          // 本 task 对该维度不作任何声称
  'no_scope_risk',          // 无越界风险（scope 收窄）
];

// ── error_code 全集（导出供 SC-7 反向变异预测红集使用）──
export const ERROR_CODES = {
  COVERAGE_CELL_MISSING: 'COVERAGE_CELL_MISSING',
  TASK_ALL_NA: 'TASK_ALL_NA',
  NA_MISSING_REASON_CODE: 'NA_MISSING_REASON_CODE',
  B_DIM_MISSING_UIPRED: 'B_DIM_MISSING_UIPRED',
  B_DIM_UIPRED_MISMATCH: 'B_DIM_UIPRED_MISMATCH',
  NA_PREDICTED_OUT_OF_DOMAIN: 'NA_PREDICTED_OUT_OF_DOMAIN',
  B_DIM_REGISTRY_UNAVAILABLE: 'B_DIM_REGISTRY_UNAVAILABLE',
  B_DIM_NA_CONTRADICTS_UI: 'B_DIM_NA_CONTRADICTS_UI',
  CELL_FACE_NOT_DECLARED: 'CELL_FACE_NOT_DECLARED',
  CELL_GATE_NOT_DECLARED: 'CELL_GATE_NOT_DECLARED',
  CELL_HARDENING_NOT_DECLARED: 'CELL_HARDENING_NOT_DECLARED',
};

// ── 计划语义常量（SC-2 / 核心机制 E 拍板，非本闸自造；禁止硬编码的只是**维度全集**，见下）──
// authority 只导出 FACES 数组，不导出「哪三面是执行面」「哪面是 UI 面」的语义；A/C/F 与 B 的
// 语义来自计划 SC-2②④⑤⑥ 原文。为防 authority 面集演进时引用不存在的面，这里以命名常量承载
// 计划语义，并始终与 authority FACES 取交集；交集为空 → 对应判据自动失效（当前 FACES = A..G，
// 交集非空，判据全量生效）。
const TASK_ALL_NA_CORE_FACES = ['A', 'C', 'F']; // SC-2②：任一 task 的 A/C/F 至少一面 covered
const B_DIM_FACE = 'B';                         // SC-2④⑤⑥：B 维度专属判据

// ── 维度全集从 authority 动态取（计划 SC-2：7 面 + 4 gate + 十类全量；禁止硬编码 7/4/10
//    或任何面名/gate 名字面量）──
function allDimensions(authority) {
  return [
    ...authority.FACES.map((f) => ({ kind: 'face', dim: f })),
    ...authority.GATES.map((g) => ({ kind: 'gate', dim: g })),
    // HARDENING_CLASSES 全量（计划 F10：明确不做子集）；数字类号与 cell.dimension_id 的字符串
    // 形态统一按 String() 定位（枚举合法性是 manifest-validate 的判据，这里只是定位格子）
    ...authority.HARDENING_CLASSES.map((h) => ({ kind: 'hardening', dim: String(h) })),
  ];
}

// POSIX 规范化：反斜杠 → 正斜杠（anchor_paths 契约本就是 repo-relative POSIX，反斜杠仅防御）
function posix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 派生 input_paths：该 task 引用的全部 SC 的 anchor_paths 并集 → POSIX 规范化 → 去重 → 排序。
 * 派生值即比对基准——cell 落盘值（若存在）必须与此逐字相等（F35 派生不采信）。
 */
export function deriveInputPaths(manifest, taskId) {
  const acc = [];
  for (const sc of manifest.scs ?? []) {
    if (sc.priority_id !== taskId) continue;
    for (const p of sc.anchor_paths ?? []) acc.push(posix(p));
  }
  return [...new Set(acc)].sort();
}

// 深度相等（只用于比对纯数据：字符串数组 / boolean / string——matcher 输出形状）
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 执行六类判据。返回违规清单（可能为空）：
 *   [{ task_id, dimension_kind, dimension_id, error_code, message }]
 *
 * @param {object} manifest  task-manifest 对象（假定已过 manifest-validate：形状/域/唯一性/
 *                           引用完整性/路径安全均合法）
 * @param {object} opts
 *   - authority：loadAuthority() 的结果（维度集 + matchUiPaths + resolveUiRegistry 均取自它）
 *   - getRepo：() => canonicalRepo 字符串，惰性求值——**仅在存在需要 registry 的 B 维度 cell 时
 *     才调用**；未提供或抛错 → 相关 B cell 记 B_DIM_REGISTRY_UNAVAILABLE（fail-closed）
 */
export function checkCoverage(manifest, { authority, getRepo } = {}) {
  const violations = [];
  const seen = new Set();
  const add = (taskId, kind, dim, code, message) => {
    const key = `${taskId} ${kind} ${dim} ${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ task_id: taskId, dimension_kind: kind, dimension_id: dim, error_code: code, message: message ?? '' });
  };

  const faces = authority.FACES;
  const coreFaces = TASK_ALL_NA_CORE_FACES.filter((f) => faces.includes(f));
  const bActive = faces.includes(B_DIM_FACE);
  const dimensions = allDimensions(authority);

  // P0-B：SC 按 id 索引（face 绑定判据用；manifest-validate 已证 sc_ids 引用完整性，这里只查声明）
  const scById = new Map((manifest.scs ?? []).map((s) => [s && s.id, s]));

  const cellsByTask = new Map();
  for (const c of manifest.coverage ?? []) {
    if (!cellsByTask.has(c.task_id)) cellsByTask.set(c.task_id, []);
    cellsByTask.get(c.task_id).push(c);
  }
  const findCell = (cells, kind, dim) =>
    cells.find((c) => c.dimension_kind === kind && String(c.dimension_id) === String(dim)) ?? null;

  for (const task of manifest.priorities ?? []) {
    const taskId = task.id;
    const cells = cellsByTask.get(taskId) ?? [];

    // ── 1) 缺格：任务 × 维度矩阵全覆盖 ──
    for (const { kind, dim } of dimensions) {
      if (!findCell(cells, kind, dim)) {
        add(taskId, kind, dim, ERROR_CODES.COVERAGE_CELL_MISSING, `缺 ${kind}:${dim} 格`);
      }
    }

    // ── 逐格判据 ──
    for (const cell of cells) {
      const kind = cell.dimension_kind;
      const dim = String(cell.dimension_id);
      const isB = bActive && kind === 'face' && dim === B_DIM_FACE;

      // ── 6) n_a_predicted 域限：仅 B 维度可用（计划「关键契约」coverage 行）──
      if (cell.status === 'n_a_predicted' && !isB) {
        add(taskId, kind, dim, ERROR_CODES.NA_PREDICTED_OUT_OF_DOMAIN, 'n_a_predicted 仅 B 维度可用');
      }

      // ── 9/10/11) P0-B 族：covered / n_a_predicted 格必须由「声明了该维度」的 SC 支持 ──
      //   face  → SC.faces 含该面；gate → SC.gates 含该 gate id；hardening → SC.hardening_classes
      //   含该类号（String 口径统一）。否则一条 SC 就能把全矩阵填成 covered 而实际没有对应工作
      //   （P0-B 实测：一条 SC-1 只声明 A/B/C 却被填进全部 7 面 + 4 闸 + 10 类，双闸 exit 0）。
      //   2026-08-09：gate/hardening 绑定随 SC 新增声明字段（gates/hardening_classes）闭环，
      //   三个 error_code 各自独占（反向变异判据：断言「恰好等于」而非「包含」）。
      const declCheck = {
        face: (sc) => !!sc && Array.isArray(sc.faces) && sc.faces.map(String).includes(dim),
        gate: (sc) => !!sc && Array.isArray(sc.gates) && sc.gates.map(String).includes(dim),
        hardening: (sc) => !!sc && Array.isArray(sc.hardening_classes) && sc.hardening_classes.map(String).includes(dim),
      };
      const declCode = {
        face: ERROR_CODES.CELL_FACE_NOT_DECLARED,
        gate: ERROR_CODES.CELL_GATE_NOT_DECLARED,
        hardening: ERROR_CODES.CELL_HARDENING_NOT_DECLARED,
      };
      const declField = { face: 'faces', gate: 'gates', hardening: 'hardening_classes' };
      if ((cell.status === 'covered' || cell.status === 'n_a_predicted') && declCheck[kind]) {
        const declared = (cell.sc_ids ?? []).some((scId) => declCheck[kind](scById.get(scId)));
        if (!declared) {
          add(taskId, kind, dim, declCode[kind],
            `${kind} ${dim} 格 status=${cell.status} 但 sc_ids(${JSON.stringify(cell.sc_ids ?? [])}) 中无任一 SC 的 ${declField[kind]} 声明包含 ${dim}`);
        }
      }

      // ── 3) n_a / n_a_predicted 必须带结构化 reason_code + 非空 evidence（SC-2③）──
      if (cell.status === 'n_a' || cell.status === 'n_a_predicted') {
        const badReason = !REASON_CODES.includes(cell.reason_code); // 自由文本不算 reason_code
        const badEvidence = typeof cell.evidence !== 'string' || cell.evidence.trim().length === 0;
        if (badReason || badEvidence) {
          add(taskId, kind, dim, ERROR_CODES.NA_MISSING_REASON_CODE,
            `n_a 必填结构化 reason_code(${REASON_CODES.join('/')})+evidence`);
        }
      }

      // ── 4/5/P0-A) B 维度：任何 status 都由本闸派生样本 + 权威 registry 并现跑 matcher ──
      //    （核心机制 E 全路径贯彻：n_a 也必须由派生 touches_ui=false 支持，不再只走
      //    reason_code 通道——「是否真无 UI 路径」不能交给被审对象自报）
      if (isB) {
        // 派生（不采信 cell 自报）——getRepo 惰性：只有到这里才需要 repo/registry
        const derivedInputs = deriveInputPaths(manifest, taskId);
        let registryInfo;
        try {
          if (typeof getRepo !== 'function') throw new Error('未提供 getRepo');
          registryInfo = authority.resolveUiRegistry(getRepo());
        } catch (e) {
          add(taskId, kind, dim, ERROR_CODES.B_DIM_REGISTRY_UNAVAILABLE,
            `repo→registry 固定映射不可用: ${e.message}`);
          continue;
        }
        const run = authority.matchUiPaths(registryInfo.registry, derivedInputs);

        // P0-A：n_a 必须由派生 touches_ui=false 支持；touches_ui=true 而标 n_a = 自报绕过
        if (cell.status === 'n_a') {
          if (run.touches_ui === true) {
            add(taskId, kind, dim, ERROR_CODES.B_DIM_NA_CONTRADICTS_UI,
              `B 维度标 n_a 但派生 touches_ui=true（matched=${JSON.stringify(run.matched_paths)}），n_a 与真实 UI 命中矛盾`);
          }
          continue; // n_a 不携带 ui_prediction；reason_code/evidence 由上方 n_a 通道负责
        }

        // covered / n_a_predicted 必须携带 ui_prediction（五字段逐字比对逻辑保持既有语义）
        const up = cell.ui_prediction;
        if (!up || typeof up !== 'object' || Array.isArray(up)) {
          add(taskId, kind, dim, ERROR_CODES.B_DIM_MISSING_UIPRED, 'B 维度必须携带 ui_prediction 结构对象');
          continue;
        }

        let mismatch = null;
        // input_paths 落盘值 = 冗余副本，必须与派生值逐字相等（禁止裁剪样本）
        if ('input_paths' in up && !deepEqual(up.input_paths, derivedInputs)) {
          mismatch = `input_paths 与派生样本（task 全部 SC 的 anchor_paths 并集）不等`;
        }
        // registry_path 落盘值必须等于权威映射
        if (!mismatch && 'registry_path' in up && up.registry_path !== registryInfo.path) {
          mismatch = `registry_path ≠ 权威 registry（${registryInfo.path}）`;
        }
        if (!mismatch) {
          // 用上方已现跑的 matcher 结果，三个输出逐字段比对
          const declared = {
            config_hash: up.config_hash,
            touches_ui: up.touches_ui,
            matched_paths: up.matched_paths,
          };
          if (declared.config_hash === undefined || declared.touches_ui === undefined || declared.matched_paths === undefined) {
            mismatch = 'ui_prediction 缺 matcher 输出字段（config_hash/touches_ui/matched_paths）';
          } else if (
            declared.config_hash !== run.config_hash ||
            declared.touches_ui !== run.touches_ui ||
            !deepEqual(declared.matched_paths, run.matched_paths)
          ) {
            mismatch = `matcher 输出与现跑不符（config_hash=${declared.config_hash !== run.config_hash}, touches_ui=${declared.touches_ui !== run.touches_ui}, matched_paths=${!deepEqual(declared.matched_paths, run.matched_paths)}）`;
          }
        }
        if (mismatch) {
          add(taskId, kind, dim, ERROR_CODES.B_DIM_UIPRED_MISMATCH, mismatch);
        }
      }
    }

    // ── 2) 单任务全 n_a：A/C/F 三面至少一面 covered（三面 cell 齐全时才判——缺格由判据 1 负责，
    //    避免同一缺陷重复报红）──
    const coreCells = coreFaces.map((f) => findCell(cells, 'face', f));
    if (coreFaces.length > 0 && coreCells.every((c) => c !== null) && coreCells.every((c) => c.status !== 'covered')) {
      add(taskId, 'face', coreFaces.join('/'), ERROR_CODES.TASK_ALL_NA,
        `A/C/F(${coreFaces.join('/')}) 三面全 n_a，至少一面必须 covered`);
    }
  }

  violations.sort((a, b) => {
    const ka = `${a.task_id} ${a.dimension_kind} ${a.dimension_id}`;
    const kb = `${b.task_id} ${b.dimension_kind} ${b.dimension_id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return violations;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest' || argv[i] === '--cwd') {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--manifest=')) {
      args.manifest = argv[i].slice('--manifest='.length);
    } else if (argv[i].startsWith('--cwd=')) {
      args.cwd = argv[i].slice('--cwd='.length);
    }
  }
  return args;
}

function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(metaUrl) === process.argv[1];
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error('用法: node coverage-matrix.mjs --manifest <manifest.json> [--cwd <git 仓目录>]');
    process.exit(2);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch (e) {
    console.error(`manifest 读取/解析失败: ${e.message}`);
    process.exit(2);
  }
  let authority;
  try {
    authority = await loadAuthority();
  } catch (e) {
    console.error(String(e.message));
    process.exit(2);
  }
  const cwd = args.cwd ?? process.cwd();
  const violations = checkCoverage(manifest, {
    authority,
    getRepo: () => canonicalRepo({ cwd }),
  });
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.task_id} ${v.dimension_kind} ${v.dimension_id} [${v.error_code}]`);
    }
    process.exit(2);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(2);
  });
}
