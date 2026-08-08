// lib/authority.mjs — 权威动态引用层（计划 Step 2 / SC-3）。
//
// 本文件是 task-priority 全链路的地基：FACES / gates / HARDENING_CLASSES /
// familyKeyOf / recomputeArtifactHash / matchUiPaths / capacity 一律从
// pr-autopilot **动态引用 + shape/value 校验**，**禁止内置任何权威常量副本**
// （复述权威 = 计划明令禁止）。任一符号缺失 / 形状不符 → 抛
// `AUTHORITY_UNREACHABLE: <细节>`，断路即 fail-closed，绝不静默用内置副本兜底。
//
// 来源映射（已核实，照此接线）：
//   - FACES / DEFAULT_REQUIREMENTS(third_seat_required_gates → GATES,
//     third_seat_required_faces → THIRD_SEAT_FACES) / familyKeyOf
//     ← pr-autopilot/scripts/verdict-validate.mjs
//   - recomputeArtifactHash ← pr-autopilot/scripts/consensus-gate.mjs
//   - HARDENING_CLASSES / HARDENING_CHECKLIST_VERSION
//     ← pr-autopilot/scripts/lib/hardening-registry.mjs
//   - matchUiPaths ← pr-autopilot/scripts/ui-paths/match.mjs（纯函数）
//   - capacity / anchorPathsMaxPerFinding / hubPathMaxShare
//     ← pr-autopilot/config/orchestration.json（现读，不本地持值）
//   - resolveUiRegistry：扫 <prAutopilotRoot>/<uiRegistryDir>/registry.*.json，
//     读每份 `repo` 字段与入参比对；恰好 1 命中才返回，0 或 >1 → AUTHORITY_UNREACHABLE
//     （计划 F35：registry 由映射派生，禁任意路径）。
//
// 注：本函数为 async（动态 import 权威模块），调用方请 `await loadAuthority()`。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'defaults.json');

// shape/value 校验判据（lead 在派工包 SC-3a 给定，非权威数据源——数据仍动态读）
const EXPECTED_GATES = ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'];
const MATCH_UI_KEYS = ['config_hash', 'matched_paths', 'touches_ui'];

function authorityUnreachable(detail) {
  return new Error(`AUTHORITY_UNREACHABLE: ${detail}`);
}

async function importFrom(root, rel) {
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } catch (e) {
    throw authorityUnreachable(`import ${rel} 失败: ${e.message}`);
  }
}

function readJsonFile(filePath, what) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw authorityUnreachable(`${what} 读取/解析失败(${filePath}): ${e.message}`);
  }
}

/**
 * 消费点边界：coverage-matrix / manifest-validate 等消费方通过本函数接收
 * authority 的 FACES，而不是硬编码字面量。本函数不检查固定长度——它把传入值
 * 原样返回，由调用方按 authority 动态值使用。
 *
 * 变异守卫意图：若未来有人把消费点的「动态引用」改回硬编码 7 面字面量
 * （如 `['A','B','C','D','E','F','G']`），当 authority 实际返回 8 面时，
 * tests/authority-import.test.mjs 的 SC-3g 断言（注入 8 面假 authority 应得 8）
 * 会**当场变红**。此边界就是那道「接线层断言」。
 */
export function assertFacesFromAuthority(faces) {
  if (!Array.isArray(faces) || faces.length === 0) {
    throw authorityUnreachable('FACES 非数组或为空（消费点收到的是硬编码字面量或空值）');
  }
  return faces; // 原样返回：消费点必须使用传入的动态值，不得自行截断/替换
}

/**
 * 加载全部权威符号 + shape/value 校验。任一校验失败 → AUTHORITY_UNREACHABLE。
 * configPath 指向含 prAutopilotRoot / uiRegistryDir 的 config JSON（缺省读本 skill
 * config/defaults.json）。
 */
export async function loadAuthority({ configPath } = {}) {
  const cfgPath = configPath ?? DEFAULT_CONFIG_PATH;
  const cfg = readJsonFile(cfgPath, 'config');

  const prAutopilotRoot = cfg.prAutopilotRoot;
  const uiRegistryDir = cfg.uiRegistryDir;
  if (typeof prAutopilotRoot !== 'string' || !prAutopilotRoot) {
    throw authorityUnreachable('config 缺 prAutopilotRoot（或非字符串）');
  }
  if (typeof uiRegistryDir !== 'string' || !uiRegistryDir) {
    throw authorityUnreachable('config 缺 uiRegistryDir（或非字符串）');
  }
  if (!existsSync(prAutopilotRoot)) {
    throw authorityUnreachable(`prAutopilotRoot 不存在: ${prAutopilotRoot}`);
  }

  // ── 1) verdict-validate.mjs：FACES / DEFAULT_REQUIREMENTS / familyKeyOf ──
  const verdict = await importFrom(prAutopilotRoot, 'scripts/verdict-validate.mjs');
  const FACES = verdict.FACES;
  const DEFAULT_REQUIREMENTS = verdict.DEFAULT_REQUIREMENTS;
  const familyKeyOf = verdict.familyKeyOf;

  if (!Array.isArray(FACES) || FACES.length !== 7) {
    throw authorityUnreachable(`FACES 长度必须为 7，实际 ${Array.isArray(FACES) ? FACES.length : typeof FACES}`);
  }
  if (FACES.some((f) => typeof f !== 'string' || !f)) {
    throw authorityUnreachable('FACES 含非字符串/空项');
  }
  if (!DEFAULT_REQUIREMENTS || typeof DEFAULT_REQUIREMENTS !== 'object') {
    throw authorityUnreachable('DEFAULT_REQUIREMENTS 缺失或非对象');
  }
  const gates = DEFAULT_REQUIREMENTS.third_seat_required_gates;
  const thirdFaces = DEFAULT_REQUIREMENTS.third_seat_required_faces;
  if (!Array.isArray(gates) || gates.length !== EXPECTED_GATES.length || !EXPECTED_GATES.every((g, i) => gates[i] === g)) {
    throw authorityUnreachable(`third_seat_required_gates 必须恰为 ${EXPECTED_GATES.join(',')}，实际 ${Array.isArray(gates) ? gates.join(',') : typeof gates}`);
  }
  if (!Array.isArray(thirdFaces) || thirdFaces.length === 0 || thirdFaces.some((f) => !FACES.includes(f))) {
    throw authorityUnreachable(`third_seat_required_faces 必须是非空 FACES 子集，实际 ${Array.isArray(thirdFaces) ? thirdFaces.join(',') : typeof thirdFaces}`);
  }
  if (typeof familyKeyOf !== 'function') {
    throw authorityUnreachable('familyKeyOf 未导出或非函数');
  }
  const fkProbe = familyKeyOf('authority-probe-invariant');
  if (typeof fkProbe !== 'string' || !fkProbe.startsWith('fk1-')) {
    throw authorityUnreachable(`familyKeyOf('x') 必须以 fk1- 开头，实际 ${String(fkProbe)}`);
  }

  // ── 2) consensus-gate.mjs：recomputeArtifactHash ──
  const consensus = await importFrom(prAutopilotRoot, 'scripts/consensus-gate.mjs');
  const recomputeArtifactHash = consensus.recomputeArtifactHash;
  if (typeof recomputeArtifactHash !== 'function') {
    throw authorityUnreachable('recomputeArtifactHash 未导出或非函数');
  }

  // ── 3) hardening-registry.mjs：HARDENING_CLASSES / HARDENING_CHECKLIST_VERSION ──
  const hardening = await importFrom(prAutopilotRoot, 'scripts/lib/hardening-registry.mjs');
  const HARDENING_CLASSES = hardening.HARDENING_CLASSES;
  const HARDENING_CHECKLIST_VERSION = hardening.HARDENING_CHECKLIST_VERSION;
  if (!Array.isArray(HARDENING_CLASSES) || HARDENING_CLASSES.length === 0 || HARDENING_CLASSES.some((c) => !Number.isInteger(c))) {
    throw authorityUnreachable(`HARDENING_CLASSES 必须是非空正整数数组，实际 ${Array.isArray(HARDENING_CLASSES) ? HARDENING_CLASSES.length : typeof HARDENING_CLASSES} 项`);
  }
  if (!Number.isInteger(HARDENING_CHECKLIST_VERSION) || HARDENING_CHECKLIST_VERSION <= 0) {
    throw authorityUnreachable(`HARDENING_CHECKLIST_VERSION 必须为正整数，实际 ${String(HARDENING_CHECKLIST_VERSION)}`);
  }

  // ── 4) ui-paths/match.mjs：matchUiPaths（纯函数）──
  const matchMod = await importFrom(prAutopilotRoot, 'scripts/ui-paths/match.mjs');
  const matchUiPaths = matchMod.matchUiPaths;
  if (typeof matchUiPaths !== 'function') {
    throw authorityUnreachable('matchUiPaths 未导出或非函数');
  }
  const probeResult = matchUiPaths({ ui_globs: [], non_ui_exceptions: [] }, []);
  const probeKeys = Object.keys(probeResult ?? {}).sort();
  if (probeKeys.join('|') !== MATCH_UI_KEYS.join('|')) {
    throw authorityUnreachable(`matchUiPaths 必须返回恰好三键 ${MATCH_UI_KEYS.join(',')}，实际 ${probeKeys.join(',') || '(无键)'}`);
  }
  if (typeof probeResult.touches_ui !== 'boolean') {
    throw authorityUnreachable(`matchUiPaths().touches_ui 必须为 boolean，实际 ${typeof probeResult.touches_ui}`);
  }

  // ── 5) orchestration.json：capacity（现读，不本地持值）──
  const orch = readJsonFile(path.join(prAutopilotRoot, 'config', 'orchestration.json'), 'orchestration.json');
  const capacity = orch.max_parallel_workers;
  const anchorPathsMaxPerFinding = orch.anchor_paths_max_per_finding;
  const hubPathMaxShare = orch.hub_path_max_share;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw authorityUnreachable(`capacity(max_parallel_workers) 必须为正整数，实际 ${JSON.stringify(capacity)}`);
  }
  if (!Number.isInteger(anchorPathsMaxPerFinding) || anchorPathsMaxPerFinding <= 0) {
    throw authorityUnreachable(`anchor_paths_max_per_finding 必须为正整数，实际 ${JSON.stringify(anchorPathsMaxPerFinding)}`);
  }
  if (typeof hubPathMaxShare !== 'number' || !(hubPathMaxShare > 0 && hubPathMaxShare <= 1)) {
    throw authorityUnreachable(`hub_path_max_share 必须在 (0,1]，实际 ${JSON.stringify(hubPathMaxShare)}`);
  }

  // ── 6) resolveUiRegistry：repo → registry 固定映射（F35：禁任意路径）──
  const registryDir = path.join(prAutopilotRoot, uiRegistryDir);
  const resolveUiRegistry = (canonicalRepo) => {
    let files;
    try {
      files = readdirSync(registryDir).filter((f) => f.startsWith('registry.') && f.endsWith('.json'));
    } catch (e) {
      throw authorityUnreachable(`uiRegistryDir 不可读(${registryDir}): ${e.message}`);
    }
    const hits = [];
    for (const f of files) {
      const reg = readJsonFile(path.join(registryDir, f), `registry ${f}`);
      if (reg.repo === canonicalRepo) hits.push({ path: path.join(registryDir, f), registry: reg });
    }
    if (hits.length !== 1) {
      throw authorityUnreachable(`registry 命中数必须恰好为 1（repo=${canonicalRepo}，实际命中 ${hits.length}，目录=${registryDir}）`);
    }
    return hits[0];
  };

  return {
    FACES,
    GATES: gates,
    THIRD_SEAT_FACES: thirdFaces,
    HARDENING_CLASSES,
    HARDENING_CHECKLIST_VERSION,
    familyKeyOf,
    recomputeArtifactHash,
    matchUiPaths,
    resolveUiRegistry,
    capacity,
    anchorPathsMaxPerFinding,
    hubPathMaxShare,
  };
}
