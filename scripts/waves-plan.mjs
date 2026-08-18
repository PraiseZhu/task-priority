#!/usr/bin/env node
// waves-plan.mjs — task-priority 波次分组器（计划 foamy-humming-widget.md Step 6 / SC-5）。
// 把 SC 清单机器裁决成「谁串行、谁并行、派几个 worker」——lead 无裁量空间。
// 实测痛点: 上午一轮 Orca 编排里 6 个 worker 反复排队、空等 lead 决策，根因就是分组靠临场判断。
//
// 规则（SC-5，权威口径 = 派工包 + 计划正文，照 fix-plan.mjs 的 union-find / hub D2 裁决思想重写轻量版，
// **不 import fix-plan.mjs**——它绑死 consensus artifact 输入形状，本模块输入是 SC 清单自带 anchor_paths）:
//   1. kind=fix 的 SC 按 anchor_paths 相交 → union-find 同组（组内串行，单 worker 承担）
//   2. 互不相交 → 强制拆开并行（不许合组）
//   3. depends_on[] 显式依赖边 → 强制拓扑分波: 被依赖的 SC 必须落在**更早的波**
//      （路径不相交但语义有序的情形，v3 之前会被错误并行）
//   4. 依赖成环（SC 级或组级）→ exit 2
//   5. 未知依赖 id（depends_on 引用不存在的 SC id）→ exit 2
//   6. kind 分三池: probe（产出 fix 消费的信息，恒在**首波**，早于所有 fix；
//      kind=probe ≠ approve-exec 的 PreWalk 交卷类——后者是 first_edit 四键现场，
//      本模块的 probe 组执行期仍走 exec 三键交卷）→ fix →
//      verify/archive（尾波区域，base = 前波集成结果）。probe/archive 组间 depends_on
//      各自池内分层（被依赖者先）; verify/archive 恒在 fix 后、probe 恒在 fix 前
//      （裁决二: probe 默认首波，即使 fix 无显式 depends_on 依赖它）
//   7. 每波内分组数即 worker 数，受 capacity 约束: 超出则同波内分批，
//      批次为 canonical partition（批数 == ceil(N/capacity)、非末批满载）
//   8. parallelism_notes（D2 口径: 记录不阻断，只要求 lead 读）:
//      a) 某路径出现在 ≥3 条 SC 的文件域中且占比 > hub_path_max_share
//         → 落一条 note（含联合度量: 移除所有命中路径后分组数 X→Y）
//      b) anchor_paths 数量超 anchor_paths_max_per_finding → 落一条 note
//         （含并行度损失度量 + 「这是记录，不阻断」+ 提示拆 SC/移 scope_note）——
//         裁决一: 降级自 exit 2（orchestration.json 原生注释是 degraded，且 D2 已把
//         hub 命中降为 note; anchor 写宽与 hub 是同类假冲突源，同一立场）
//
// capacity / hubPathMaxShare / anchorPathsMaxPerFinding 一律经 lib/authority.mjs **现读**
// （单一真相源 = pr-autopilot/config/orchestration.json，计划 F5: 双处持值必漂移）。
// CLI 不接受 capacity 自报；库参数 capacity/hubShare/anchorMax/authority 只允许测试注入。
//
// 确定性: 同输入必得同输出——SC 先按 id 字典序归一，组内 sc_ids 字典序、组按最小 sc_id 排序、
// Kahn 层内按组固定序、分批为确定性切片、notes 字典序。

import { readFileSync, writeFileSync, renameSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAuthority } from './lib/authority.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** fail-closed 错误载体: code 机器可读，CLI 出口统一 exit 2。 */
export class WavesPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WavesPlanError';
    this.code = code;
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new WavesPlanError('CONFIG_READ_FAILED', `读取 ${p} 失败: ${e.message}`);
  }
}

function writeJsonAtomic(p, obj) {
  const dir = dirname(p);
  const tmp = join(mkdtempSync(join(tmpdir(), 'waves-plan-')), 'out.json');
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, p);
}

// ─────────────────────────────────────────────────────────────────────────────
// union-find: 文件域相交 → 同组。确定性: 组内 sc_ids 字典序、组按最小 sc_id 排序。
// records: [{sc_id, paths[]}]；空 paths 的 SC 不与任何人相交 → 独立一组（它不碰文件，可自由并行）。
// ─────────────────────────────────────────────────────────────────────────────
export function groupByAnchorIntersection(records) {
  const parent = new Map(records.map((r) => [r.sc_id, r.sc_id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const A = new Set(records[i].paths);
      if (records[j].paths.some((p) => A.has(p))) unite(records[i].sc_id, records[j].sc_id);
    }
  }
  const byRoot = new Map();
  for (const r of records) {
    const root = find(r.sc_id);
    if (!byRoot.has(root)) byRoot.set(root, { sc_ids: [], paths: new Set() });
    const g = byRoot.get(root);
    g.sc_ids.push(r.sc_id);
    for (const p of r.paths) g.paths.add(p);
  }
  return [...byRoot.values()]
    .map((g) => ({ sc_ids: g.sc_ids.sort(), paths: [...g.paths].sort() }))
    .sort((a, b) => a.sc_ids[0].localeCompare(b.sc_ids[0]));
}

// 忽略给定路径集后的分组数（hub 联合度量用）。余集为空的 SC 各算独立一组
// （它不再与任何人冲突 = 可自由并行），**不能丢弃**——丢弃会低估分组数、把并行度损失算小。
export function groupCountIgnoring(records, ignore) {
  const reduced = records.map((r) => ({ ...r, paths: r.paths.filter((x) => !ignore.has(x)) }));
  const nonEmpty = reduced.filter((r) => r.paths.length > 0);
  const emptyCount = reduced.length - nonEmpty.length;
  return (nonEmpty.length ? groupByAnchorIntersection(nonEmpty).length : 0) + emptyCount;
}

// hub 检测（SC-5 规则 8）: 路径出现在 ≥3 条且占比 > share 的 SC 域中 → 命中。
// 联合度量: 把**所有**命中路径一起移除后分组数 X→Y——逐路径度量在冗余连接对（source+test 成对）
// 上恒为 0（fix-plan D2 实测），联合度量才看得见真实串行化损失。
// 产出是 note，**不阻断、不 degraded**（D2 裁决: 并行度不是正确性属性——机器分辨不出
// 合法同模块耦合与锚点污染，该由人看一眼）。
export function hubViolations(records, share, label) {
  if (records.length === 0) return [];
  const freq = new Map();
  for (const r of records) for (const p of new Set(r.paths)) freq.set(p, (freq.get(p) ?? 0) + 1);
  const hits = [...freq]
    .filter(([p, n]) => n >= 3 && n > records.length * share)
    .map(([p]) => p)
    .sort();
  if (hits.length === 0) return [];
  const before = groupByAnchorIntersection(records).length;
  const after = groupCountIgnoring(records, new Set(hits));
  const loss = after > before
    ? `若这些路径不在各 SC 域中，分组数会从 ${before} 增到 ${after}（并行度损失 ${after - before} 组）`
    : `即便这些路径都不在各 SC 域中，分组数仍为 ${before}——这些路径不是分组数的成因`;
  return hits.map((p) => `${label} hub 路径 ${p} 出现在 ${freq.get(p)}/${records.length} 条 SC 域中（> hub_path_max_share=${share}）。${loss}。这是记录，不阻断（D2: 并行度不是正确性属性）——若确属锚点写宽了，请 lead 在计划期收窄 anchor_paths`);
}

// Kahn 分层: 返回 [groupId...] 层，层 0 = 最早执行（入度 0 = 无依赖）。组内依赖边已同组消化。
// 组依赖成环 → GROUP_DEPENDS_CYCLE（SC 级无环但组级有环时仍要拦——组是 SC 的分区，
// 分区可以制造 SC 级图不存在的环，如 G1→G2→G1 由不同 SC 对的依赖构成）。
function kahnLayers(groups, depEdges) {
  const byId = new Map(groups.map((g) => [g.group_id, g]));
  const indeg = new Map(groups.map((g) => [g.group_id, 0]));
  const dependents = new Map(groups.map((g) => [g.group_id, []]));
  for (const [src, dsts] of depEdges) {
    for (const dst of dsts) {
      indeg.set(src, indeg.get(src) + 1);
      dependents.get(dst).push(src);
    }
  }
  const layers = [];
  let frontier = groups.filter((g) => indeg.get(g.group_id) === 0).map((g) => g.group_id);
  frontier.sort((a, b) => byId.get(a).seq - byId.get(b).seq);
  let total = 0;
  while (frontier.length > 0) {
    layers.push(frontier);
    total += frontier.length;
    const next = [];
    for (const gid of frontier) {
      for (const d of dependents.get(gid)) {
        const v = indeg.get(d) - 1;
        indeg.set(d, v);
        if (v === 0) next.push(d);
      }
    }
    frontier = next.sort((a, b) => byId.get(a).seq - byId.get(b).seq);
  }
  if (total !== groups.length) {
    const cyclic = groups.filter((g) => indeg.get(g.group_id) > 0).map((g) => g.group_id).sort();
    throw new WavesPlanError('GROUP_DEPENDS_CYCLE', `组依赖成环，环内组: ${cyclic.join(', ')}（fail-closed）`);
  }
  return layers;
}

// canonical partition: 批数 == ceil(N/cap)，非末批满载（前批每批 cap 个），末批余数。
function canonicalBatches(seq, cap) {
  const n = seq.length;
  if (n === 0) return [];
  const nb = Math.ceil(n / cap);
  const out = [];
  for (let i = 0; i < nb; i++) out.push(seq.slice(i * cap, Math.min((i + 1) * cap, n)));
  return out;
}

// SC 级依赖环检测（Kahn 剥洋葱，剩者成环）。未知依赖 id 已在上游校验。
function detectScCycle(scs, scById) {
  const indeg = new Map(scs.map((s) => [s.id, (s.depends_on ?? []).length]));
  const dependents = new Map(scs.map((s) => [s.id, []]));
  for (const s of scs) for (const d of s.depends_on ?? []) dependents.get(d).push(s.id);
  const queue = scs.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.pop();
    seen += 1;
    for (const d of dependents.get(id)) {
      const v = indeg.get(d) - 1;
      indeg.set(d, v);
      if (v === 0) queue.push(d);
    }
  }
  if (seen !== scs.length) {
    const cyclic = scs.filter((s) => indeg.get(s.id) > 0).map((s) => s.id).sort();
    throw new WavesPlanError('SC_DEPENDS_CYCLE', `depends_on 成环，环内 SC: ${cyclic.join(', ')}（fail-closed）`);
  }
}

/**
 * 主入口（async: authority 经动态 import 现读）。
 *
 * 生产路径: 不传 capacity/hubShare/anchorMax/authority → 全部从 loadAuthority() 现读
 * （单一真相源 = pr-autopilot/config/orchestration.json）。CLI 即此路径。
 * 测试注入: 传 authority 对象（{capacity, hubPathMaxShare, anchorPathsMaxPerFinding}）
 * 或直接传三个标量；注入值仍做 shape 校验，防坏值进入分批/占比运算。
 *
 * @param {object} opts
 * @param {Array}  opts.scs       SC 清单 [{id, kind, anchor_paths[], depends_on?[]}]
 * @param {number} [opts.capacity] 测试注入
 * @param {number} [opts.hubShare] 测试注入
 * @param {number} [opts.anchorMax] 测试注入
 * @param {object} [opts.authority] 测试注入（含三值）
 * @returns {{waves: Array, parallelism_notes: Array, capacity: number}}
 */
export async function buildWavesPlan({ scs, capacity = null, hubShare = null, anchorMax = null, authority = null }) {
  const A = authority ?? (await loadAuthority());
  const cap = capacity ?? A.capacity;
  const hub = hubShare ?? A.hubPathMaxShare;
  const maxAnchors = anchorMax ?? A.anchorPathsMaxPerFinding;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new WavesPlanError('BAD_CAPACITY', `capacity=${cap} 非法——必须是 ≥1 整数（fail-closed）`);
  }
  if (typeof hub !== 'number' || !(hub > 0 && hub <= 1)) {
    throw new WavesPlanError('BAD_HUB_SHARE', `hub_path_max_share=${hub} 非法——必须在 (0,1]（fail-closed）`);
  }
  if (!Number.isInteger(maxAnchors) || maxAnchors < 1) {
    throw new WavesPlanError('BAD_ANCHOR_MAX', `anchor_paths_max_per_finding=${maxAnchors} 非法——必须是 ≥1 整数（fail-closed）`);
  }
  if (!Array.isArray(scs)) {
    throw new WavesPlanError('BAD_INPUT', 'scs 必须是非空数组');
  }

  // ── 输入校验 + 归一（按 id 字典序: 输出与 JSON 字段顺序无关，确定性）──
  // 两遍遍历: 先建全表再校验 depends_on——依赖可前向/后向引用，与数组顺序无关
  const scById = new Map();
  for (const s of scs) {
    if (!s || typeof s.id !== 'string' || !s.id) {
      throw new WavesPlanError('BAD_INPUT', 'SC 缺 id 或 id 非字符串');
    }
    if (scById.has(s.id)) {
      throw new WavesPlanError('DUPLICATE_SC_ID', `SC id 重复: ${s.id}`);
    }
    scById.set(s.id, s);
  }
  const overLimitScs = []; // anchor_paths 超限收集（裁决一: 记录不阻断，落 note）
  for (const s of scs) {
    if (!['fix', 'verify', 'probe', 'archive'].includes(s.kind)) {
      throw new WavesPlanError('UNKNOWN_KIND', `SC ${s.id} 未知 kind=${String(s.kind)}（允许 fix|verify|probe|archive）`);
    }
    if (!Array.isArray(s.anchor_paths)) {
      throw new WavesPlanError('BAD_ANCHOR_PATHS', `SC ${s.id} 的 anchor_paths 必须是数组`);
    }
    if (s.anchor_paths.length > maxAnchors) {
      overLimitScs.push(s.id); // 不抛——D2: 并行度不是正确性属性，机器分辨不出合法宽影响面与锚点污染
    }
    for (const d of s.depends_on ?? []) {
      if (typeof d !== 'string' || !d) {
        throw new WavesPlanError('BAD_DEPENDS_ON', `SC ${s.id} 的 depends_on 含非法项 ${JSON.stringify(d)}`);
      }
      if (!scById.has(d)) {
        throw new WavesPlanError('UNKNOWN_SC_ID', `SC ${s.id} 依赖未知 SC ${d}（fail-closed）`);
      }
    }
  }
  detectScCycle(scs, scById);

  // ── 分组: probe 池（首波，产出 fix 消费的信息）+ fix 池 + 尾波池（verify/archive），各自 union-find ──
  const toRecord = (s) => ({ sc_id: s.id, paths: [...new Set(s.anchor_paths)].sort() });
  const probeRecs = scs.filter((s) => s.kind === 'probe').map(toRecord);
  const fixRecs = scs.filter((s) => s.kind === 'fix').map(toRecord);
  const lateRecs = scs.filter((s) => s.kind === 'verify' || s.kind === 'archive').map(toRecord);
  const probeGroups = groupByAnchorIntersection(probeRecs);
  const fixGroups = groupByAnchorIntersection(fixRecs);
  const lateGroups = groupByAnchorIntersection(lateRecs);
  // 组编号: probe 池 p1..、fix 池 g1..、尾波池 v1..（各按最小 sc_id 序）; seq = 全局固定序（Kahn/分批用）
  const probeGroupList = probeGroups.map((g, i) => ({ ...g, group_id: `p${i + 1}`, seq: i }));
  const fixGroupList = fixGroups.map((g, i) => ({ ...g, group_id: `g${i + 1}`, seq: probeGroupList.length + i }));
  const lateGroupList = lateGroups.map((g, i) => ({ ...g, group_id: `v${i + 1}`, seq: probeGroupList.length + fixGroupList.length + i }));
  const allGroupList = [...probeGroupList, ...fixGroupList, ...lateGroupList];

  // ── 组依赖边（SC 级 depends_on → 组级; 同组内依赖被串行消化，忽略）──
  // 方向: src 依赖 dst（src 必须比 dst 晚）。池序: probe → fix → verify/archive。
  // - probe 依赖非 probe → 语义矛盾 exit 2（probe 恒在首波，被依赖者不可能更早）
  // - fix 依赖 probe → 天然满足（probe 首波恒在 fix 前），不建边
  // - fix 依赖 verify/archive → 语义矛盾 exit 2（尾波恒在 fix 后）
  // - verify/archive 依赖 fix/probe → 天然满足（前池恒在前），不建边
  const groupOf = new Map();
  for (const g of allGroupList) for (const sid of g.sc_ids) groupOf.set(sid, g.group_id);
  const probeDepEdges = new Map();
  const fixDepEdges = new Map();
  const lateDepEdges = new Map();
  const addEdge = (m, src, dst) => {
    if (!m.has(src)) m.set(src, new Set());
    m.get(src).add(dst);
  };
  for (const s of scs) {
    const srcId = groupOf.get(s.id);
    for (const d of s.depends_on ?? []) {
      const dstId = groupOf.get(d);
      if (srcId === dstId) continue; // 同组: 单 worker 串行，自然满足
      const dstKind = scById.get(d).kind;
      if (s.kind === 'probe') {
        if (dstKind !== 'probe') {
          throw new WavesPlanError('PROBE_DEPENDS_LATE', `SC ${s.id}(probe) 依赖 ${d}(${dstKind})——probe 恒在首波，依赖非 probe 无法在任何波序中满足（fail-closed）`);
        }
        addEdge(probeDepEdges, srcId, dstId);
      } else if (s.kind === 'fix') {
        if (dstKind === 'probe') continue;
        if (dstKind !== 'fix') {
          throw new WavesPlanError('FIX_DEPENDS_LATE', `SC ${s.id}(fix) 依赖 ${d}(${dstKind})——fix 依赖非 fix 无法在任何波序中满足（fail-closed）`);
        }
        addEdge(fixDepEdges, srcId, dstId);
      } else {
        if (dstKind === 'fix' || dstKind === 'probe') continue;
        addEdge(lateDepEdges, srcId, dstId);
      }
    }
  }

  // ── 分层: probe 层 → fix 层 → 尾波层; 每层内按 capacity 分批 ──
  const probeLayers = kahnLayers(probeGroupList, probeDepEdges);
  const fixLayers = kahnLayers(fixGroupList, fixDepEdges);
  const lateLayers = kahnLayers(lateGroupList, lateDepEdges);
  const waves = [];
  let waveNo = 1;
  const byId = new Map(allGroupList.map((g) => [g.group_id, g]));
  for (const layer of [...probeLayers, ...fixLayers, ...lateLayers]) {
    const seqSorted = layer.slice().sort((a, b) => byId.get(a).seq - byId.get(b).seq);
    for (const batch of canonicalBatches(seqSorted, cap)) {
      waves.push({
        wave: waveNo,
        groups: batch.map((gid) => {
          const g = byId.get(gid);
          return { group_id: gid, sc_ids: g.sc_ids, worker_count: 1 };
        }),
      });
      waveNo += 1;
    }
  }

  // ── notes（D2 口径: 检测保留、后果不阻断）──
  // a) anchor_paths 超限（裁决一: 降级自 exit 2——合法宽影响面任务不被拒死）:
  //    度量 = 把该 SC 截断到上限内路径后分组数变化（超限部分视为可能的多余锚点）
  const notes = [];
  const allRecs = [...probeRecs, ...fixRecs, ...lateRecs];
  for (const id of overLimitScs) {
    const s = scById.get(id);
    const before = groupByAnchorIntersection(allRecs).length;
    const truncated = allRecs.map((r) => (r.sc_id === id ? { ...r, paths: r.paths.slice(0, maxAnchors) } : r));
    const after = groupByAnchorIntersection(truncated).length;
    const loss = after > before
      ? `若该 SC 的 anchor_paths 收敛到上限内，分组数会从 ${before} 增到 ${after}（并行度损失 ${after - before} 组）`
      : `即便该 SC 只保留上限内路径，分组数仍为 ${before}——这些路径不是分组数的成因`;
    notes.push(`SC ${id} 的 anchor_paths 数量 ${s.anchor_paths.length} 超过 anchor_paths_max_per_finding=${maxAnchors}。${loss}。这是记录，不阻断（D2: 并行度不是正确性属性——机器分辨不出合法宽影响面与锚点污染）——若确属锚点写宽了请拆 SC 或移 scope_note`);
  }
  // b) hub 路径: probe / fix / 尾波三池同判据分开查
  notes.push(
    ...hubViolations(probeRecs, hub, 'probe'),
    ...hubViolations(fixRecs, hub, 'fix'),
    ...hubViolations(lateRecs, hub, 'verify'),
  );
  notes.sort();

  return { waves, parallelism_notes: notes, capacity: cap };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: node scripts/waves-plan.mjs --manifest <task-manifest.json> [--out waves.json]
// capacity 不接受 CLI 自报（SC-5: 一律 authority 现读）。
// exit code: 0 正常; 2 fail-closed（环 / 未知 id / 输入非法 / authority 不可达）。
// ─────────────────────────────────────────────────────────────────────────────
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        args[k] = v;
        i += 1;
      } else {
        args[k] = true;
      }
    }
  }
  const run = async () => {
    if (!args.manifest) {
      process.stderr.write('用法: node scripts/waves-plan.mjs --manifest <task-manifest.json> [--out waves.json]\n（capacity 来自 authority 现读，不接受 CLI 自报）\n');
      process.exit(2);
    }
    const data = readJson(args.manifest);
    const scs = Array.isArray(data) ? data : data.scs;
    const result = await buildWavesPlan({ scs }); // 生产路径: authority 现读
    if (args.out) writeJsonAtomic(args.out, result);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  };
  run().catch((e) => {
    if (e instanceof WavesPlanError || (e && typeof e.message === 'string' && e.message.startsWith('AUTHORITY_UNREACHABLE'))) {
      process.stderr.write(`[WAVES-PLAN-FAIL-CLOSED] ${e.code ?? 'AUTHORITY_UNREACHABLE'}: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  });
}
