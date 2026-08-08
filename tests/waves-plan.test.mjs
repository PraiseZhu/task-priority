// tests/waves-plan.test.mjs — SC-5 八支必过 + 额外行为（计划 foamy-humming-widget.md）。
// 验收命令: cd <skill根> && node --test tests/waves-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  buildWavesPlan,
  groupByAnchorIntersection,
  groupCountIgnoring,
  hubViolations,
  WavesPlanError,
} from '../scripts/waves-plan.mjs';
import { loadAuthority } from '../scripts/lib/authority.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(HERE, '..');
const WAVES_SCRIPT = join(SKILL_ROOT, 'scripts', 'waves-plan.mjs');
const REAL_AUTOPILOT = '/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot';
const ORCH_PATH = join(REAL_AUTOPILOT, 'config', 'orchestration.json');
const FIXTURES = join(HERE, 'fixtures', 'waves');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ── fixture helpers ──
const sc = (id, kind, paths, deps) => ({ id, kind, anchor_paths: paths, ...(deps ? { depends_on: deps } : {}) });
const FIX = (id, paths, deps) => sc(id, 'fix', paths, deps);
const PROBE = (id, paths, deps) => sc(id, 'probe', paths, deps);
const VERIFY = (id, paths, deps) => sc(id, 'verify', paths, deps);
// 测试注入的 authority 对象（shape 对齐 lib/authority.mjs 返回值的三个消费字段）
const AUTH = (capacity, hubShare = 0.5, anchorMax = 20) => ({
  capacity,
  hubPathMaxShare: hubShare,
  anchorPathsMaxPerFinding: anchorMax,
});

const planOf = (scs, opts = {}) => buildWavesPlan({ scs, ...opts });

function waveOf(r, scId) {
  return r.waves.find((w) => w.groups.some((g) => g.sc_ids.includes(scId))).wave;
}
function allGroups(r) {
  return r.waves.flatMap((w) => w.groups);
}

// ── CLI 端到端 helper: 返回 {code, out, err} ──
function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [WAVES_SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 1: anchor_paths 相交 → 强制同组（union-find，组内串行单 worker 承担）
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-1 anchor_paths 相交 → 强制同组', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/a.ts', 'src/b.ts']), FIX('f3', ['src/c.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  const groups = allGroups(r);
  assert.equal(groups.length, 2, '相交的 f1/f2 同组、不相交的 f3 独立组 → 共 2 组');
  const gA = groups.find((g) => g.sc_ids.includes('f1'));
  assert.deepEqual(gA.sc_ids, ['f1', 'f2']);
  const gB = groups.find((g) => g.sc_ids.includes('f3'));
  assert.deepEqual(gB.sc_ids, ['f3']);
  assert.notEqual(gA.group_id, gB.group_id, '不同组');
  assert.equal(gA.worker_count, 1, '组内串行 = 单 worker 承担');
  // 两个组互不相交 → 同一波并行（capacity 8 够）
  assert.equal(waveOf(r, 'f1'), waveOf(r, 'f3'));
  assert.equal(r.waves.length, 1);
  assert.equal(r.waves[0].groups.length, 2, '每波内分组数 = worker 数 = 2');
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 2: 互不相交 → 强制拆开并行（不许合组）
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-2 互不相交 → 强制拆开并行（不许合组）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), FIX('f3', ['src/c.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.equal(r.waves[0].groups.length, 3, '3 个互不相交的 fix SC = 3 组同一波并行');
  for (const g of r.waves[0].groups) assert.deepEqual(g.sc_ids.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 3: depends_on[] 显式依赖边 → 强制拓扑分波（被依赖者更早波）
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-3 depends_on → 被依赖者落更早波（链 + 扇出）', async () => {
  // 链: f1 → f2 → f3（f1 依赖 f2，f2 依赖 f3）
  const scs = [FIX('f1', ['src/a.ts'], ['f2']), FIX('f2', ['src/b.ts'], ['f3']), FIX('f3', ['src/c.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.ok(waveOf(r, 'f3') < waveOf(r, 'f2'), 'f3 被 f2 依赖 → 更早');
  assert.ok(waveOf(r, 'f2') < waveOf(r, 'f1'), 'f2 被 f1 依赖 → 更早');

  // 扇出: f1 依赖 [f2, f3]，f2/f3 互不相交 → 同波并行、都早于 f1
  const scs2 = [FIX('f1', ['src/a.ts'], ['f2', 'f3']), FIX('f2', ['src/b.ts']), FIX('f3', ['src/c.ts'])];
  const r2 = await planOf(scs2, { authority: AUTH(8) });
  assert.equal(waveOf(r2, 'f2'), waveOf(r2, 'f3'), '无依赖关系时 f2/f3 同波并行');
  assert.ok(waveOf(r2, 'f2') < waveOf(r2, 'f1'));
  assert.equal(r2.waves[0].groups.length, 2, '首波 2 组并行');
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 4: depends_on 成环 → exit 2（SC 级 + 组级 + CLI 出口）
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-4 SC 级依赖成环 → fail-closed（SC_DEPENDS_CYCLE）', async () => {
  const scs = [FIX('f1', ['src/a.ts'], ['f2']), FIX('f2', ['src/b.ts'], ['f1'])];
  await assert.rejects(
    () => planOf(scs, { authority: AUTH(8) }),
    (e) => e instanceof WavesPlanError && e.code === 'SC_DEPENDS_CYCLE' && e.message.includes('f1') && e.message.includes('f2'),
  );
});

test('SC5-4b SC 级无环但组级成环 → fail-closed（GROUP_DEPENDS_CYCLE）', async () => {
  // SC 依赖图 A→B、D→C 无环；但组 G1={A,C}（共享 x.ts）、G2={B,D}（共享 y.ts）
  // 组依赖 G1→G2（A→B）且 G2→G1（D→C）→ 组级环，必须拦（SC 级检测看不见）
  const scs = [
    FIX('A', ['src/x.ts'], ['B']),
    FIX('B', ['src/y.ts']),
    FIX('C', ['src/x.ts', 'src/c.ts']),
    FIX('D', ['src/y.ts', 'src/d.ts'], ['C']),
  ];
  await assert.rejects(
    () => planOf(scs, { authority: AUTH(8) }),
    (e) => e instanceof WavesPlanError && e.code === 'GROUP_DEPENDS_CYCLE',
  );
});

test('SC5-4c CLI 成环 fixture → exit 2 且 stderr 点名', () => {
  const { code, err } = runCli(['--manifest', join(FIXTURES, 'manifest-cycle.json')]);
  assert.equal(code, 2, `exit code 应为 2，实际 ${code}`);
  assert.match(err, /SC_DEPENDS_CYCLE/);
  assert.match(err, /f1/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 5: 未知依赖 id → exit 2
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-5 depends_on 引用未知 SC id → fail-closed（UNKNOWN_SC_ID）', async () => {
  const scs = [FIX('f1', ['src/a.ts'], ['nonexistent-sc'])];
  await assert.rejects(
    () => planOf(scs, { authority: AUTH(8) }),
    (e) => e instanceof WavesPlanError && e.code === 'UNKNOWN_SC_ID' && e.message.includes('nonexistent-sc'),
  );
  const { code, err } = runCli(['--manifest', join(FIXTURES, 'manifest-unknown-dep.json')]);
  assert.equal(code, 2, `CLI exit code 应为 2，实际 ${code}`);
  assert.match(err, /UNKNOWN_SC_ID/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 6: capacity 经 authority 现读——不是硬编码 8
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-6a 生产路径（无注入）→ capacity 等于 authority 现读值', async () => {
  const r = await buildWavesPlan({ scs: [FIX('f1', ['src/a.ts'])] }); // 真实 authority
  const orchValue = readJson(ORCH_PATH).max_parallel_workers;
  assert.equal(typeof r.capacity, 'number');
  assert.equal(r.capacity, orchValue, `输出 capacity 必须等于 orchestration.json 现读值（${orchValue}）`);
  assert.ok(Number.isInteger(r.capacity) && r.capacity >= 1);
});

test('SC5-6b 临时 config 指向临时 orchestration.json → 改配置值，输出跟着变（现读证明）', async () => {
  // 派工包允许的方式: 临时拷贝一份 config 指向临时 orchestration.json（绝不真改 pr-autopilot 文件）。
  // 临时 root: 权威依赖链用 cpSync 复制自真实 pr-autopilot（authority 动态 import 可解析；
  // 也不能用 symlink——本机 sandbox 对 symlink 解析返回 ENOENT），config/ 放修改版
  // orchestration.json + defaults.json。为什么必须是复制而非链接，见下方 ★ 注释。
  const tmp = mkdtempSync(join(tmpdir(), 'waves-auth-'));
  try {
    // 临时 root = cpSync 复制真实 pr-autopilot 的权威依赖链（scripts/schemas/config）。
    // ★为什么用 cpSync 而不用 hardlink/symlink: cpSync 是复制、无 inode 共享——hardlink
    //   曾让 writeFileSync(O_TRUNC) 透过共享 inode 穿透改写真实 pr-autopilot/config/
    //   orchestration.json（真实事故，2026-08-08，已恢复+弃用本机制；加固清单第 2 类
    //   「共享可变资源」的正确形态是换掉共享，不是靠调用点 guard 避险）。
    cpSync(join(REAL_AUTOPILOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
    cpSync(join(REAL_AUTOPILOT, 'schemas'), join(tmp, 'schemas'), { recursive: true });
    cpSync(join(REAL_AUTOPILOT, 'config'), join(tmp, 'config'), { recursive: true });
    // config/ 接下来由测试覆盖为修改版（max_parallel_workers=3/2）——cpSync 后是独立副本，可安全覆盖

    const baseCfg = { prAutopilotRoot: tmp, uiRegistryDir: 'scripts/ui-paths' };
    const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), FIX('f3', ['src/c.ts'])];

    for (const [want, expectedWaveGroups] of [
      [3, 3], // capacity 3 → 3 组一波
      [2, 2], // capacity 2 → 首批 2 组满载
    ]) {
      const orch = readJson(ORCH_PATH);
      orch.max_parallel_workers = want;
      writeFileSync(join(tmp, 'config', 'orchestration.json'), JSON.stringify(orch, null, 2));
      writeFileSync(join(tmp, 'config', 'defaults.json'), JSON.stringify(baseCfg, null, 2));
      const A = await loadAuthority({ configPath: join(tmp, 'config', 'defaults.json') });
      assert.equal(A.capacity, want, 'authority 从临时配置现读出修改后的值');
      const r = await buildWavesPlan({ scs, authority: A });
      assert.equal(r.capacity, want, `输出 capacity 跟随配置值 ${want}，不是硬编码`);
      assert.equal(r.waves[0].groups.length, expectedWaveGroups, `capacity=${want} 时首波组数`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test('SC5-6c 注入 capacity=2 → 超限分批为 canonical partition（ceil(3/2)=2 批、首批满载）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), FIX('f3', ['src/c.ts'])];
  const r = await planOf(scs, { authority: AUTH(2) });
  assert.equal(r.capacity, 2);
  assert.equal(r.waves.length, 2, '批数 == ceil(3/2) == 2');
  assert.equal(r.waves[0].groups.length, 2, '非末批满载 = 2 组');
  assert.equal(r.waves[1].groups.length, 1, '末批余数 = 1 组');
  assert.equal(r.waves[0].wave, 1);
  assert.equal(r.waves[1].wave, 2);
});

test('SC5-6d 注入不同 capacity → 输出不同（证明非硬编码 8）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), FIX('f3', ['src/c.ts'])];
  const r2 = await planOf(scs, { authority: AUTH(2) });
  const r5 = await planOf(scs, { authority: AUTH(5) });
  const r8 = await planOf(scs, { authority: AUTH(8) });
  assert.equal(r2.capacity, 2);
  assert.equal(r5.capacity, 5);
  assert.equal(r8.capacity, 8);
  assert.notEqual(JSON.stringify(r2), JSON.stringify(r5), 'capacity 2 与 5 的输出必须不同');
  assert.equal(r5.waves.length, 1, 'capacity 5 → 3 组一波不分批');
  assert.equal(r5.waves[0].groups.length, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 7: kind=verify 全部进最后一波
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-7 kind=verify 全部进最后一波', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), VERIFY('v1', ['tests/v1.test.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  const lastWave = r.waves[r.waves.length - 1];
  assert.ok(lastWave.groups.some((g) => g.sc_ids.includes('v1')), 'verify 组必须出现在最末 wave 条目');
  assert.ok(waveOf(r, 'v1') > waveOf(r, 'f1') && waveOf(r, 'v1') > waveOf(r, 'f2'), 'verify 晚于所有 fix 波');
});

test('SC5-7b verify 组间 depends_on → 尾波区域内分层（被依赖者先），仍在所有 fix 之后', async () => {
  const scs = [
    FIX('f1', ['src/a.ts']),
    VERIFY('v1', ['tests/v1.test.ts'], ['v2']),
    VERIFY('v2', ['tests/v2.test.ts']),
  ];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.ok(waveOf(r, 'v2') < waveOf(r, 'v1'), 'v1 依赖 v2 → v2 更早波');
  assert.ok(waveOf(r, 'v1') > waveOf(r, 'f1'), '两个 verify 都晚于 fix');
});

test('SC5-7c 多个 verify 互不相交 → 同末波并行（不许合组）', async () => {
  const scs = [
    FIX('f1', ['src/a.ts']),
    VERIFY('v1', ['tests/v1.test.ts']),
    VERIFY('v2', ['tests/v2.test.ts']),
  ];
  const r = await planOf(scs, { authority: AUTH(8) });
  const lastWave = r.waves[r.waves.length - 1];
  assert.equal(lastWave.groups.length, 2, '末波 2 个 verify 组并行');
  assert.ok(lastWave.groups.every((g) => g.sc_ids.length === 1));
});

// ═══════════════════════════════════════════════════════════════════════════
// SC-5 支 8: 同输入输出确定性
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-8 同输入跑三次 → 输出逐字相同（确定性）', async () => {
  const scs = [
    FIX('f1', ['src/a.ts']),
    FIX('f2', ['src/a.ts', 'src/b.ts']),
    FIX('f3', ['src/c.ts'], ['f2']),
    VERIFY('v1', ['tests/v1.test.ts']),
    FIX('f4', ['src/shared.ts', 'src/d.ts']),
    FIX('f5', ['src/shared.ts', 'src/e.ts']),
    FIX('f6', ['src/shared.ts', 'src/f.ts']),
  ];
  const r1 = await planOf(scs, { authority: AUTH(8) });
  const r2 = await planOf(scs, { authority: AUTH(8) });
  const r3 = await planOf(scs, { authority: AUTH(8) });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), '第 2 次运行必须逐字相同');
  assert.equal(JSON.stringify(r2), JSON.stringify(r3), '第 3 次运行必须逐字相同');
});

test('SC5-8b 输入数组乱序 → 输出仍逐字相同（与 JSON 字段顺序无关）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts'], ['f1']), VERIFY('v1', ['tests/v1.test.ts'])];
  const shuffled = [scs[2], scs[0], scs[1]];
  const r1 = await planOf(scs, { authority: AUTH(8) });
  const r2 = await planOf(shuffled, { authority: AUTH(8) });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// ═══════════════════════════════════════════════════════════════════════════
// 额外: parallelism_notes（hub 检测，note 不阻断）+ 各 fail-closed 边界
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-9 hub 路径（≥3 条且占比 > share）→ parallelism_notes 含联合度量，且不阻断', async () => {
  const scs = [
    FIX('f1', ['src/shared.ts', 'src/a1.ts']),
    FIX('f2', ['src/shared.ts', 'src/a2.ts']),
    FIX('f3', ['src/shared.ts', 'src/a3.ts']),
    FIX('f4', ['src/a4.ts']),
  ];
  const r = await planOf(scs, { authority: AUTH(8, 0.5) });
  assert.equal(r.parallelism_notes.length, 1, 'shared.ts 3/4 > 0.5 → 恰好一条 note');
  assert.match(r.parallelism_notes[0], /src\/shared\.ts/);
  // 联合度量: 移除 shared.ts 后分组数 2 → 4（并行度损失 2 组）
  assert.match(r.parallelism_notes[0], /分组数会从 2 增到 4（并行度损失 2 组）/);
  // note 不阻断: 仍正常产出 waves（f1/f2/f3 同组串行是事实，不是缺陷）
  assert.equal(r.waves.length, 1);
  assert.equal(r.waves[0].groups.length, 2);
});

test('SC5-9b hub 边界: 2/4 占比不超阈值 → 无 note', async () => {
  const scs = [
    FIX('f1', ['src/shared.ts', 'src/a1.ts']),
    FIX('f2', ['src/shared.ts', 'src/a2.ts']),
    FIX('f3', ['src/a3.ts']),
    FIX('f4', ['src/a4.ts']),
  ];
  const r = await planOf(scs, { authority: AUTH(8, 0.5) });
  assert.deepEqual(r.parallelism_notes, [], '2/4 = 0.5 不 > 0.5 且 n<3 → 无 note');
});

test('SC5-9c hubViolations / groupCountIgnoring 单测（联合度量）', () => {
  const records = [
    { sc_id: 'f1', paths: ['p', 'a'] },
    { sc_id: 'f2', paths: ['p', 'b'] },
    { sc_id: 'f3', paths: ['p', 'c'] },
    { sc_id: 'f4', paths: ['d'] },
  ];
  const notes = hubViolations(records, 0.5, 'fix');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /fix hub 路径 p/);
  assert.equal(groupByAnchorIntersection(records).length, 2);
  assert.equal(groupCountIgnoring(records, new Set(['p'])), 4);
});

test('SC5-10 fix 依赖非 fix（verify）→ 语义矛盾 fail-closed（FIX_DEPENDS_LATE）', async () => {
  const scs = [FIX('f1', ['src/a.ts'], ['v1']), VERIFY('v1', ['tests/v1.test.ts'])];
  await assert.rejects(
    () => planOf(scs, { authority: AUTH(8) }),
    (e) => e instanceof WavesPlanError && e.code === 'FIX_DEPENDS_LATE',
  );
});

test('SC5-11 anchor_paths 超 anchorPathsMaxPerFinding → 落 note、不阻断（裁决一: 由 exit 2 按 D2 口径降级）', async () => {
  // 裁决一（lead 2026-08-08）: orchestration.json 原生注释是「超限→degraded」而非 hard exit；
  // 且 D2 已把 hub 命中从 degraded 降为不阻断的 note（并行度不是正确性属性，机器分辨不出
  // 合法宽影响面与锚点污染）——anchor 写宽与 hub 是同类假冲突源，故同一立场: 记录而非阻断。
  const scs = [FIX('f1', ['src/a.ts', 'src/b.ts', 'src/c.ts'])];
  const r = await planOf(scs, { authority: AUTH(8, 0.5, 2) });
  assert.equal(r.parallelism_notes.length, 1, '恰好一条 anchor 超限 note');
  assert.match(r.parallelism_notes[0], /anchor_paths 数量 3 超过 anchor_paths_max_per_finding=2/);
  assert.match(r.parallelism_notes[0], /这是记录，不阻断/);
  assert.match(r.parallelism_notes[0], /拆 SC 或移 scope_note/);
  assert.equal(r.waves.length, 1, '不阻断: 仍正常产出波次');
  assert.equal(r.waves[0].groups.length, 1);
  // 语义: 单条超限 SC 不与任何人冲突 → 度量是「不是分组数的成因」分支
  assert.match(r.parallelism_notes[0], /分组数仍为 1/);
});

test('SC5-11b anchor 超限且与他人相交 → note 含并行度损失度量（X→Y）', async () => {
  const scs = [
    FIX('f1', ['src/shared.ts', 'src/x1.ts', 'src/x2.ts']), // 3 条 > 2 → 超限
    FIX('f2', ['src/shared.ts', 'src/a.ts']),
    FIX('f3', ['src/b.ts']),
  ];
  const r = await planOf(scs, { authority: AUTH(8, 0.5, 2) });
  // 当前: shared 使 f1/f2 同组 → 2 组; 若 f1 收敛到上限内（保留 shared,x1）→ 仍与 f2 相交 → 2 组
  // 用「截断保留前 2 条」的度量口径断言存在「分组数会从 X 增到 Y」或「仍为 X」任一形态
  assert.ok(r.parallelism_notes.some((n) => n.includes('anchor_paths 数量 3 超过 anchor_paths_max_per_finding=2')), '存在超限 note');
  assert.match(r.parallelism_notes[0], /（并行度损失 \d+ 组）|分组数仍为 \d+/);
  assert.equal(r.waves.length, 1, '仍正常产出波次');
});

test('SC5-12 其他输入非法 → fail-closed（缺 id / 未知 kind / 重复 id / 坏 capacity）', async () => {
  await assert.rejects(() => planOf([{ kind: 'fix', anchor_paths: ['a'] }], { authority: AUTH(8) }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(() => planOf([FIX('f1', ['a']), FIX('f1', ['b'])], { authority: AUTH(8) }), (e) => e.code === 'DUPLICATE_SC_ID');
  await assert.rejects(() => planOf([sc('f1', 'global', ['a'])], { authority: AUTH(8) }), (e) => e.code === 'UNKNOWN_KIND');
  await assert.rejects(() => planOf([FIX('f1', ['a'])], { authority: AUTH(0) }), (e) => e.code === 'BAD_CAPACITY');
});

// ═══════════════════════════════════════════════════════════════════════════
// 裁决二: kind=probe 进首波（早于所有 fix）——「先查清再修」，方向不可颠倒
// ═══════════════════════════════════════════════════════════════════════════
test('SC5-13 probe 进首波（早于所有 fix 波），组内规则同 fix（相交同组）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), FIX('f2', ['src/b.ts']), PROBE('p1', ['src/probe1.ts']), PROBE('p2', ['src/probe2.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  const probeWaves = r.waves.filter((w) => w.groups.some((g) => g.sc_ids.includes('p1') || g.sc_ids.includes('p2'))).map((w) => w.wave);
  const fixWaves = r.waves.filter((w) => w.groups.some((g) => g.sc_ids.includes('f1') || g.sc_ids.includes('f2'))).map((w) => w.wave);
  for (const pw of probeWaves) for (const fw of fixWaves) {
    assert.ok(pw < fw, `probe 波 ${pw} 必须早于所有 fix 波 ${fw}`);
  }
  assert.equal(r.waves[0].groups.length, 2, 'p1/p2 互不相交 → 首波 2 组并行');
  assert.deepEqual(r.waves[0].groups.map((g) => g.sc_ids).sort(), [['p1'], ['p2']]);
  // probe 相交 → 同组（组内串行单 worker）
  const r2 = await planOf([PROBE('p1', ['src/x.ts']), PROBE('p2', ['src/x.ts', 'src/y.ts']), FIX('f1', ['src/a.ts'])], { authority: AUTH(8) });
  const probeGroups2 = r2.waves[0].groups;
  assert.equal(probeGroups2.length, 1, '相交的 probe 同组');
  assert.deepEqual(probeGroups2[0].sc_ids, ['p1', 'p2']);
});

test('SC5-13b probe 组间 depends_on → probe 池内分层（被依赖者先，仍都在 fix 前）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), PROBE('p1', ['src/probe1.ts'], ['p2']), PROBE('p2', ['src/probe2.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.ok(waveOf(r, 'p2') < waveOf(r, 'p1'), 'p1 依赖 p2 → p2 更早');
  assert.ok(waveOf(r, 'p1') < waveOf(r, 'f1'), '所有 probe 都早于 fix');
});

test('SC5-13c probe 依赖 fix → 语义矛盾 fail-closed（PROBE_DEPENDS_LATE）', async () => {
  const scs = [PROBE('p1', ['src/probe1.ts'], ['f1']), FIX('f1', ['src/a.ts'])];
  await assert.rejects(
    () => planOf(scs, { authority: AUTH(8) }),
    (e) => e instanceof WavesPlanError && e.code === 'PROBE_DEPENDS_LATE',
  );
});

test('SC5-13d fix 依赖 probe → 天然满足（probe 首波），拓扑正确', async () => {
  const scs = [FIX('f1', ['src/a.ts'], ['p1']), PROBE('p1', ['src/probe1.ts'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.ok(waveOf(r, 'p1') < waveOf(r, 'f1'), 'probe 仍早于依赖它的 fix');
});

test('SC5-13e archive 保持尾波区（裁决二: 只有 probe 移到首波）', async () => {
  const scs = [FIX('f1', ['src/a.ts']), PROBE('p1', ['src/probe1.ts']), sc('a1', 'archive', ['README.md'])];
  const r = await planOf(scs, { authority: AUTH(8) });
  assert.ok(waveOf(r, 'a1') > waveOf(r, 'f1'), 'archive 仍在 fix 之后（尾波区）');
  assert.ok(waveOf(r, 'a1') > waveOf(r, 'p1'), 'archive 在 probe 之后');
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI 端到端
// ═══════════════════════════════════════════════════════════════════════════
test('CLI 端到端: basic manifest → exit 0，输出 shape 与语义正确', () => {
  const { code, out, err } = runCli(['--manifest', join(FIXTURES, 'manifest-basic.json')]);
  assert.equal(code, 0, `exit 0，stderr: ${err}`);
  const r = JSON.parse(out);
  assert.ok(Array.isArray(r.waves) && r.waves.length >= 2);
  assert.ok(Array.isArray(r.parallelism_notes));
  assert.equal(typeof r.capacity, 'number');
  // fixture 语义: f1/f2 相交同组（g1），f3 depends_on f2 → g2 晚于 g1，v1 最末
  const waveOf = (id) => r.waves.find((w) => w.groups.some((g) => g.sc_ids.includes(id))).wave;
  const g1 = r.waves.flatMap((w) => w.groups).find((g) => g.sc_ids.includes('f1'));
  assert.deepEqual(g1.sc_ids, ['f1', 'f2']);
  assert.ok(waveOf('f1') < waveOf('f3'));
  assert.ok(waveOf('f3') < waveOf('v1'));
  for (const w of r.waves) for (const g of w.groups) assert.equal(g.worker_count, 1);
});

test('CLI 缺 --manifest → exit 2', () => {
  const { code, err } = runCli([]);
  assert.equal(code, 2);
  assert.match(err, /用法/);
});
