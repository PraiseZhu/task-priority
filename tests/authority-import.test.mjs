// tests/authority-import.test.mjs — SC-3 权威引用层 + hash 层验收（计划 Step 2）。
//
// 覆盖：SC-3a 符号可达 + shape/value 校验；SC-3b 断路 fail-closed；SC-3c core-hash
// 不动点；SC-3d core-hash 纳入 schema_version/slug；SC-3e planHash 排除 receipts；
// SC-3f repo-identity 离线派生；SC-3g 消费点变异守卫。
//
// 运行：cd <SKILL_ROOT> && node --test tests/authority-import.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  loadAuthority,
  assertFacesFromAuthority,
} from '../scripts/lib/authority.mjs';
import {
  CORE_EXCLUDE_KEYS,
  PLAN_RECEIPTS_MARKER,
  manifestCoreHash,
  planHash,
} from '../scripts/lib/hashing.mjs';
import {
  canonicalRepo,
  normalizeRemoteUrl,
} from '../scripts/lib/repo-identity.mjs';

const SKILL_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PR_AUTOPILOT_ROOT = '/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot';
const MIVO_DIR = '/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas';

function tmpConfigFile({ prAutopilotRoot, uiRegistryDir }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-authority-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ prAutopilotRoot, uiRegistryDir }));
  return { dir, cfgPath };
}

// ── SC-3a：七个权威符号全部取到 + shape/value 校验 ────────────────────────────
test('SC-3a: 权威符号可达且 shape/value 校验通过', async () => {
  const auth = await loadAuthority();

  assert.ok(Array.isArray(auth.FACES), 'FACES 应为数组');
  assert.equal(auth.FACES.length, 7, 'FACES.length 必须为 7');
  assert.ok(auth.FACES.every((f) => typeof f === 'string' && f), 'FACES 项应为非空字符串');

  assert.deepEqual(
    auth.GATES,
    ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'],
    'GATES 必须恰为那 4 个 gate 名',
  );

  assert.ok(Array.isArray(auth.THIRD_SEAT_FACES) && auth.THIRD_SEAT_FACES.length > 0);
  assert.ok(auth.THIRD_SEAT_FACES.every((f) => auth.FACES.includes(f)), 'THIRD_SEAT_FACES 应为 FACES 子集');

  assert.ok(Array.isArray(auth.HARDENING_CLASSES) && auth.HARDENING_CLASSES.length > 0, 'HARDENING_CLASSES 非空');
  assert.ok(auth.HARDENING_CLASSES.every((c) => Number.isInteger(c)), 'HARDENING_CLASSES 应为整数数组');
  assert.ok(Number.isInteger(auth.HARDENING_CHECKLIST_VERSION) && auth.HARDENING_CHECKLIST_VERSION > 0);

  assert.equal(typeof auth.familyKeyOf, 'function');
  const fk = auth.familyKeyOf('probe-invariant');
  assert.ok(typeof fk === 'string' && fk.startsWith('fk1-'), `familyKeyOf 应以 fk1- 开头，实际 ${String(fk)}`);

  assert.equal(typeof auth.recomputeArtifactHash, 'function');
  assert.equal(typeof auth.matchUiPaths, 'function');

  assert.ok(Number.isInteger(auth.capacity) && auth.capacity > 0, `capacity 应为正整数，实际 ${auth.capacity}`);
  assert.ok(Number.isInteger(auth.anchorPathsMaxPerFinding) && auth.anchorPathsMaxPerFinding > 0);
  assert.equal(typeof auth.hubPathMaxShare, 'number');
});

test('SC-3a 补充: FACES/GATES 值动态来自 verdict-validate（非内置副本）', async () => {
  const auth = await loadAuthority();
  const verdict = await import(pathToFileURL(path.join(PR_AUTOPILOT_ROOT, 'scripts', 'verdict-validate.mjs')).href);
  assert.deepEqual(auth.FACES, verdict.FACES, 'FACES 必须逐字等于 verdict-validate 导出');
  assert.deepEqual(auth.GATES, verdict.DEFAULT_REQUIREMENTS.third_seat_required_gates);
  assert.deepEqual(auth.THIRD_SEAT_FACES, verdict.DEFAULT_REQUIREMENTS.third_seat_required_faces);
});

test('SC-3a: resolveUiRegistry 恰好 1 命中返回 {path, registry}；0 命中抛错', async () => {
  const auth = await loadAuthority();
  const mivo = auth.resolveUiRegistry('xindong/mivo-canvas');
  assert.equal(mivo.registry.repo, 'xindong/mivo-canvas');
  assert.ok(mivo.path.endsWith('registry.mivo.json'), `path 应指向 registry.mivo.json，实际 ${mivo.path}`);

  const cindy = auth.resolveUiRegistry('makecindy/cindy');
  assert.ok(cindy.path.endsWith('registry.cindy.json'));

  assert.throws(() => auth.resolveUiRegistry('no/such-repo'), /AUTHORITY_UNREACHABLE/);
});

test('SC-3a: resolveUiRegistry >1 命中抛 AUTHORITY_UNREACHABLE（复制权威仓构造同 repo 双 registry）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-authority-dup-'));
  try {
    // 复制真实 pr-autopilot 的 scripts + config + schemas（loadAuthority 全链路真实可达；
    // verdict-validate.mjs 运行期读 schemas/review-verdict.schema.json）
    cpSync(path.join(PR_AUTOPILOT_ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    cpSync(path.join(PR_AUTOPILOT_ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
    cpSync(path.join(PR_AUTOPILOT_ROOT, 'schemas'), path.join(dir, 'schemas'), { recursive: true });
    // 追加一份 repo 相同的 registry → 与 registry.mivo.json 撞 repo
    writeFileSync(
      path.join(dir, 'scripts', 'ui-paths', 'registry.dup.json'),
      JSON.stringify({ repo: 'xindong/mivo-canvas', ui_globs: [] }),
    );
    const cfgPath = path.join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ prAutopilotRoot: dir, uiRegistryDir: 'scripts/ui-paths' }));

    const auth = await loadAuthority({ configPath: cfgPath });
    assert.throws(() => auth.resolveUiRegistry('xindong/mivo-canvas'), /AUTHORITY_UNREACHABLE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SC-3b：断路 fail-closed ───────────────────────────────────────────────────
test('SC-3b: prAutopilotRoot 不存在的临时 config → loadAuthority 抛 AUTHORITY_UNREACHABLE', async () => {
  const { dir, cfgPath } = tmpConfigFile({
    prAutopilotRoot: '/nonexistent/task-priority-authority-root',
    uiRegistryDir: 'scripts/ui-paths',
  });
  try {
    await assert.rejects(
      loadAuthority({ configPath: cfgPath }),
      /AUTHORITY_UNREACHABLE/,
      '不得静默用内置副本兜底——必须抛 AUTHORITY_UNREACHABLE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SC-3c：core-hash 不动点 ───────────────────────────────────────────────────
test('SC-3c: core-hash 不动点——回填顶层与 packet 的 manifest_core_hash 后重算不变', () => {
  const manifest = {
    schema_version: 'v1',
    slug: 'demo-slug',
    goal: '示例任务',
    context_refs: [],
    priorities: [{ id: 'p1', title: 't', why: 'w', pr_split: { suggested_prs: 1, functional_pr: true } }],
    scs: [{
      id: 's1', priority_id: 'p1', kind: 'verify', granularity: 'assertion',
      change: '改动描述', holds: '约束描述',
      verify: { cmd: 'node', args: ['--test'] }, expect: 'OK',
      anchor_paths: ['src/a.ts'], faces: ['A'],
    }],
    coverage: [{ task_id: 'p1', dimension_kind: 'face', dimension_id: 'A', status: 'covered', sc_ids: ['s1'] }],
    waves: [{ wave: 1, groups: [{ group_id: 'g1', sc_ids: ['s1'], worker_count: 1 }] }],
    dispatch: {
      capacity: 8,
      packets: [{
        group_id: 'g1', scs_inline: ['s1'], allowed_paths: ['src/a.ts'], forbidden: ['src/b.ts'],
        verify_cmds: ['node --test'], submit_format: 'x', instruction: '用 goal skill 执行', manifest_core_hash: '',
      }],
    },
  };

  const h1 = manifestCoreHash(manifest);
  // 回填顶层 + packet 的绑定字段
  manifest.manifest_core_hash = h1;
  manifest.dispatch.packets[0].manifest_core_hash = h1;
  const h2 = manifestCoreHash(manifest);
  assert.equal(h2, h1, '回填 manifest_core_hash 后重算必须得到同值（构造上的不动点，无环）');
});

// ── SC-3d：core-hash 纳入 schema_version/slug ─────────────────────────────────
test('SC-3d: 只改 schema_version 或只改 slug → hash 必变（证明不是字段白名单漏算）', () => {
  const base = { schema_version: 'v1', slug: 's1', goal: 'g', context_refs: [], scs: [], coverage: [] };
  const hBase = manifestCoreHash(base);

  const hVer = manifestCoreHash({ ...base, schema_version: 'v2' });
  assert.notEqual(hVer, hBase, '只改 schema_version 时 hash 必须变');

  const hSlug = manifestCoreHash({ ...base, slug: 's2' });
  assert.notEqual(hSlug, hBase, '只改 slug 时 hash 必须变');
});

// ── SC-3e：planHash 排除 receipts ─────────────────────────────────────────────
test('SC-3e: planHash 排除尾部 receipts——改 receipts 不变、改正文必变', () => {
  const body = '# 任务优先级计划\n\n## SC-1\n\n- [ ] 目标一\n- [ ] 目标二\n';
  const hBody = planHash(body);

  // 追加/修改 receipts 区块 → 不变
  const withReceipts = body + PLAN_RECEIPTS_MARKER + '\nreceipt 1: {slug: "x"}\n';
  assert.equal(planHash(withReceipts), hBody, '追加 receipts 区块后 planHash 必须不变');
  const mutatedReceipts = body + PLAN_RECEIPTS_MARKER + '\nreceipt 2: {slug: "y", hash: "zzz"}\n';
  assert.equal(planHash(mutatedReceipts), hBody, '修改 receipts 内容后 planHash 必须不变');

  // 改正文任一字 → 必变
  assert.notEqual(planHash(body.replace('目标一', '目标一改')), hBody, '改正文任一字 planHash 必须变');
  assert.notEqual(planHash(body + '多一行正文'), hBody, '正文末尾追加内容 planHash 必须变');
});

// ── SC-3f：repo-identity 离线派生 ─────────────────────────────────────────────
test('SC-3f: canonicalRepo 在真实 git 仓离线派生 owner/name（不调 gh）', () => {
  const repo = canonicalRepo({ cwd: MIVO_DIR });
  assert.equal(repo, 'xindong/mivo-canvas', `MivoCanvas 仓应派生 xindong/mivo-canvas，实际 ${repo}`);
});

test('SC-3f: ssh 与 https 两种 remote URL 形态均归一成 owner/name', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(normalizeRemoteUrl('git@github.com:owner/repo'), 'owner/repo');
  assert.equal(normalizeRemoteUrl('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(normalizeRemoteUrl('https://github.com/owner/repo/'), 'owner/repo');
});

test('SC-3f: 真实 git 调用路径——临时仓 ssh remote 经 canonicalRepo 归一', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-identity-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:some/org-repo.git'], { cwd: dir });
    assert.equal(canonicalRepo({ cwd: dir }), 'some/org-repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SC-3g：消费点变异守卫 ─────────────────────────────────────────────────────
test('SC-3g: 消费点变异守卫——注入 8 面假 authority，硬编码 7 面字面量必红', () => {
  // 意图：消费点（coverage-matrix 等）必须消费 authority 的动态 FACES。
  // 若未来有人把消费点改回硬编码 7 面字面量（如 ['A'..'G']），当权威实际返回
  // 8 面时，下面两条断言会**当场变红**——这就是本守卫存在的意义。
  const fakeFaces8 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const consumed = assertFacesFromAuthority(fakeFaces8);
  assert.equal(consumed.length, fakeFaces8.length, '消费点必须原样使用动态 FACES');
  assert.equal(consumed.length, 8, '注入 8 面时消费点必须看到 8 面——硬编码 7 在这里红');
});

// ── 补充：排除键单一实现 ──────────────────────────────────────────────────────
test('CORE_EXCLUDE_KEYS: 黑名单恰为 manifest_core_hash + receipts', () => {
  assert.deepEqual([...CORE_EXCLUDE_KEYS], ['manifest_core_hash', 'receipts']);
  // 递归剔除生效：任何层级的同名键都被剔除（含 dispatch.packets[].manifest_core_hash）
  const m = {
    manifest_core_hash: 'x', receipts: 'y',
    dispatch: { packets: [{ manifest_core_hash: 'z', group_id: 'g1' }] },
  };
  const h1 = manifestCoreHash(m);
  const h2 = manifestCoreHash({
    manifest_core_hash: 'CHANGED', receipts: 'CHANGED',
    dispatch: { packets: [{ manifest_core_hash: 'CHANGED', group_id: 'g1' }] },
  });
  assert.equal(h2, h1, '黑名单键的任何值都不进 hash——改其值 hash 不变');
});
