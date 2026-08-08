/**
 * sc-preflight.test.mjs — SC-4 预验证器测试
 *
 * 覆盖（SC-4 六支 + 补充）：
 *  1. 五态各一支：fabricated / red_ok / green_warn / exists_not_run / infra_fail
 *  2. 参数注入拒绝：--config / -e / 绝对路径 / ..  → 拒（不进实跑）
 *  3. 空目标拒绝：vitest run 无目标路径 → 拒（防整仓发现）
 *  4. 脚本副作用被隔离承接：写文件测试实跑后主工作树无 diff，且 worktree 已被删除
 *  5. 超时清理：命令超时 → infra_fail 且 worktree 仍被清理干净
 *  6. infra 与 red 区分：module-not-found 类失败 → infra_fail（不是 red_ok）
 *
 * F5（2026-08-09）新增覆盖：
 *  - 目标判定与 runner 发现规则对齐：根目录测试（root.test.js）实跑不误判 fabricated；
 *    目标必须真实存在（lib/x.test.js 不存在 → fabricated）；非测试文件 → fabricated
 *  - 防绕过：白名单 cmd 形状不匹配（--coverage / 未知 flag / 多位置参数）→ fabricated，
 *    绝不降级可放行的 exists_not_run；cosmetic flag（--reporter 两种形态）放行仍实跑
 *
 * 测试目标 = 每次运行动态构造的一次性 fixture git 仓库（模板 tests/fixtures/preflight/repo-template），
 * 内含 node_modules/.bin/{vitest,tsc} 测试替身（复刻真实 runner 的失败输出形状）。
 * 白名单 / existsOnly / reject patterns / test roots / worktreeTmpRoot 从 config/defaults.json 读取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(SKILL_ROOT, 'scripts', 'sc-preflight.mjs');
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(SKILL_ROOT, 'config', 'defaults.json'), 'utf8'),
);
const TMP_ROOT = CONFIG.worktreeTmpRoot; // 从 config 读，不硬编码
const FIXTURE_TEMPLATE = path.join(SKILL_ROOT, 'tests', 'fixtures', 'preflight', 'repo-template');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 构造一次性 fixture git 仓库（在 worktreeTmpRoot 下，跑完自动删） */
function makeFixtureRepo(t, opts = {}) {
  const dir = path.join(TMP_ROOT, 'fixtures', `fixture-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(FIXTURE_TEMPLATE, dir, { recursive: true });
  for (const f of opts.removeFiles || []) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 会走 gpg 签名——内存压力下
  // gpg 失败导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory）。
  // fixture 是本地测试工件，签名无任何价值，显式关掉保证确定性。
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 跑一次 sc-preflight，返回解析后的 JSON 结果 */
function preflight(repo, cmd, args, extra = {}) {
  const argv = ['--repo', repo, '--cmd', cmd, ...args];
  if (extra.timeoutMs) argv.push('--timeout-ms', String(extra.timeoutMs));
  const out = execFileSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

/** 主工作树 diff 行数（隔离测试断言用） */
function workingTreeDiff(repo) {
  const out = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  return out.trim() === '' ? [] : out.trim().split('\n');
}

// ---------------------------------------------------------------------------
// 支 1：五态各一支
// ---------------------------------------------------------------------------

test('SC-4 fabricated：编造的命令（不存在、不在白名单、不在 scripts）', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'no-such-cmd-xyz', ['run', 'src/fail.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /编造的命令/);
});

test('SC-4 red_ok：vitest 断言失败 → 红→绿有意义', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'failing', 'src/fail.test.js']);
  assert.equal(r.status, 'red_ok');
  assert.equal(r.exit_code, 1);
  assert.match(r.note, /AssertionError|×/);
  assert.match(r.note, /sha256=/);
  // 跑完 worktree 已被删除
  assert.equal(fs.existsSync(r.worktree), false);
});

test('SC-4 green_warn：vitest 全绿 → 空转嫌疑（需要 lead disposition）', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'passing', 'src/pass.test.js']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
  assert.match(r.note, /空转嫌疑/);
});

test('SC-4 exists_not_run：existsOnly runner（node）只验存在性', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'node', ['--version']);
  assert.equal(r.status, 'exists_not_run');
  assert.match(r.note, /existsOnly/);
});

test('SC-4 infra_fail：module-not-found 类失败 ≠ red_ok', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'broken', 'src/broken.test.js']);
  assert.equal(r.status, 'infra_fail');
  assert.equal(r.exit_code, 1);
  assert.match(r.note, /不匹配.*断言失败特征/);
});

// ---------------------------------------------------------------------------
// 支 2：参数注入拒绝
// ---------------------------------------------------------------------------

test('SC-4 参数注入拒绝：--config → 拒，不进实跑', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--config', 'vitest.config.ts', 'src/fail.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /拒绝参数 "--config"/);
});

test('SC-4 参数注入拒绝：-e → 拒，不进实跑', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-e', 'process.exit(1)', 'src/fail.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /拒绝参数/);
});

test('SC-4 参数注入拒绝：绝对路径 → 拒，不进实跑', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '/etc/passwd']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /拒绝参数 "\/etc\/passwd"/);
});

test('SC-4 参数注入拒绝：.. 路径穿越 → 拒，不进实跑', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '../outside.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /拒绝参数/);
});

// ---------------------------------------------------------------------------
// 支 3：空目标拒绝
// ---------------------------------------------------------------------------

test('SC-4 空目标拒绝：vitest run 无登记路径（防整仓发现）', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /空目标拒绝/);
});

test('SC-4 空目标拒绝：仅 -t 无路径同样拒', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'foo']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /空目标拒绝/);
});

test('SC-4 目标不存在拒绝：lib/x.test.js 是测试形状但文件不存在', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', 'lib/x.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /目标文件 "lib\/x\.test\.js" 不存在/);
});

// ---------------------------------------------------------------------------
// 支 4：脚本副作用被隔离承接
// ---------------------------------------------------------------------------

test('SC-4 隔离：写文件测试实跑后主工作树无 diff，且 worktree 已删除', (t) => {
  const repo = makeFixtureRepo(t);
  const before = workingTreeDiff(repo);
  assert.deepEqual(before, [], 'fixture 主工作树应初始干净');

  const r = preflight(repo, 'vitest', ['run', '-t', 'side-effect', 'src/side-effect.test.js']);
  assert.equal(r.status, 'green_warn', '写文件测试本身 exit 0');
  assert.equal(fs.existsSync(r.worktree), false, 'worktree 必须已被删除');

  const after = workingTreeDiff(repo);
  assert.deepEqual(after, [], '副作用必须落在一次性 worktree 内，主工作树无 diff');
});

// ---------------------------------------------------------------------------
// 支 5：超时清理
// ---------------------------------------------------------------------------

test('SC-4 超时：命令超时 → infra_fail 且 worktree 仍被清理干净', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'slow', 'src/slow.test.js'], {
    timeoutMs: 500,
  });
  assert.equal(r.status, 'infra_fail');
  assert.match(r.note, /超时/);
  assert.equal(fs.existsSync(r.worktree), false, '超时后 worktree 也必须被清理');
});

// ---------------------------------------------------------------------------
// 支 6：infra 与 red 区分（已由支 1 的 infra_fail 覆盖）+ 补充分支
// ---------------------------------------------------------------------------

test('SC-4 补充：tsc --noEmit 断言失败特征 → red_ok', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'tsc', ['--noEmit']);
  assert.equal(r.status, 'red_ok');
  assert.equal(r.exit_code, 1);
  assert.match(r.note, /error TS/);
  assert.equal(fs.existsSync(r.worktree), false);
});

test('SC-4 补充：tsc --noEmit 无类型错误 → green_warn', (t) => {
  // 移除 TS_ERROR_MARK 文件后提交 → tsc 替身 exit 0
  const repo = makeFixtureRepo(t, { removeFiles: ['src/ts-error.ts'] });
  const r = preflight(repo, 'tsc', ['--noEmit']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
});

test('SC-4 防绕过：白名单 cmd 形状不匹配（--coverage）→ fabricated，不降级 exists_not_run', (t) => {
  // F5 形态三修复：旧行为「形状不符但 vitest 在 deps → exists_not_run → final-gate 放行」，
  // 意味着加一个 flag 就能跳过实跑。现在一律 fabricated（fail-safe 大声拒），
  // coverage 非 cosmetic flag（改变执行语义）不纳入白名单。
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--coverage', 'src/fail.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /形状不匹配/);
  assert.match(r.note, /不降级 exists_not_run/);
});

test('SC-4 防绕过：未知 flag → fabricated，不降级 exists_not_run', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--whatever', 'src/fail.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /未知 flag\/参数 "--whatever"/);
});

test('SC-4 防绕过：多个位置参数 → fabricated（vitest 目标只能一个）', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', 'src/fail.test.js', 'src/pass.test.js']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /多个位置参数/);
});

test('SC-4 非测试文件拒绝：src/ts-ok.ts 存在但不匹配 include 规则', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', 'src/ts-ok.ts']);
  assert.equal(r.status, 'fabricated');
  assert.match(r.note, /不是测试文件/);
});

test('SC-4 根目录测试实跑：root.test.js（vitest include 覆盖根目录）→ green_warn 非 fabricated', (t) => {
  // F5 形态一修复：真实仓根目录测试（如 MIVO vitest.setup.test.ts）不再被目录白名单误判
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', 'root.test.js']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
});

test('SC-4 cosmetic flag 仍实跑：--reporter=dot → green_warn 非 exists_not_run', (t) => {
  // F5 形态三裁决：--reporter 是纯展示 flag，纳入形状仍实跑（不经由它降级只验存在性）
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--reporter=dot', 'src/pass.test.js']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
});

test('SC-4 cosmetic flag 仍实跑：--reporter dot（空格形态）→ green_warn', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--reporter', 'dot', 'src/pass.test.js']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
});

test('SC-4 cosmetic flag 与 -t 组合仍实跑：--reporter=dot -t passing → green_warn', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '--reporter=dot', '-t', 'passing', 'src/pass.test.js']);
  assert.equal(r.status, 'green_warn');
  assert.equal(r.exit_code, 0);
});

test('SC-4 补充：existsOnly runner 不存在 → fabricated', (t) => {
  const repo = makeFixtureRepo(t);
  const fakeBinDir = path.join(TMP_ROOT, 'fixtures', 'fakebin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const oldPath = process.env.PATH;
  try {
    // 构造一个不含任何 runner 的 PATH，使 playwright 不可解析
    process.env.PATH = fakeBinDir;
    const r = preflight(repo, 'playwright', ['test']);
    assert.equal(r.status, 'fabricated');
    assert.match(r.note, /不可解析/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test('SC-4 补充：非 git 仓库目标 → exists_not_run 降级，不在主工作树实跑', (t) => {
  // 目录需含真实测试文件（F5 后文件存在性在 worktree 阶段之前校验），
  // 让流程走到「非 git → 无法建 worktree → 降级」分支
  const dir = path.join(TMP_ROOT, 'fixtures', `nongit-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE_TEMPLATE, 'src', 'fail.test.js'),
    path.join(dir, 'src', 'fail.test.js'),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = preflight(dir, 'vitest', ['run', '-t', 'x', 'src/fail.test.js']);
  assert.equal(r.status, 'exists_not_run');
  assert.match(r.note, /只验存在性/);
});

// ---------------------------------------------------------------------------
// P0#3（2026-08-09）：执行凭据 + verify 命令指纹确定性
// ---------------------------------------------------------------------------

test('SC-4 P0#3: 产物携带执行凭据（sc_id/verify_fingerprint/repo_head）', (t) => {
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'passing', 'src/pass.test.js'], {});
  assert.equal(r.sc_id, null, '未传 --sc-id → null（诊断透传）');
  assert.match(r.verify_fingerprint, /^[0-9a-f]{16}$/, 'verify_fingerprint 必须是 16 位 hex');
  assert.match(r.repo_head, /^[0-9a-f]{40}$/, 'repo_head 必须是 HEAD 的 40 位 hex（诊断）');
  // 指纹与 CLI 命令一致：--sc-id 只是透传，不改变指纹
  const r2 = preflight(repo, 'vitest', ['run', '-t', 'passing', 'src/pass.test.js'], {});
  assert.equal(r.verify_fingerprint, r2.verify_fingerprint, '同一命令必须同一指纹');
});

test('SC-4 P0#3: 指纹确定性——同一命令不同写法同指纹；不同命令/参数必不同', async () => {
  const { verifyFingerprint } = await import('../scripts/sc-preflight.mjs');
  // 同一命令不同写法（多余空格）：cmd 与 arg 边缘空格 → 同一指纹
  assert.equal(
    verifyFingerprint('vitest', ['run', 'src/a.test.js']),
    verifyFingerprint('  vitest  ', ['run', '  src/a.test.js']),
    '多余空格写法必须同一指纹（规范化：cmd trim+折叠、args trim）'
  );
  // 不同命令必须不同指纹
  assert.notEqual(verifyFingerprint('vitest', ['run', 'src/a.test.js']), verifyFingerprint('tsc', ['--noEmit']));
  // 不同参数必须不同指纹（同一命令不同语义）
  assert.notEqual(verifyFingerprint('vitest', ['run', 'src/a.test.js']), verifyFingerprint('vitest', ['run', 'src/b.test.js']));
  // args 顺序敏感（顺序是语义的一部分）
  assert.notEqual(verifyFingerprint('vitest', ['run', 'a', 'b']), verifyFingerprint('vitest', ['run', 'b', 'a']));
  // 缺省 args 与空数组同指纹
  assert.equal(verifyFingerprint('node'), verifyFingerprint('node', []));
});

test('SC-4 P0#3: 产物 verify_fingerprint == 导出函数对同一命令的重算（指纹判据闭环）', async (t) => {
  const { verifyFingerprint } = await import('../scripts/sc-preflight.mjs');
  const repo = makeFixtureRepo(t);
  const r = preflight(repo, 'vitest', ['run', '-t', 'failing', 'src/fail.test.js']);
  assert.equal(r.status, 'red_ok');
  assert.equal(
    r.verify_fingerprint,
    verifyFingerprint('vitest', ['run', '-t', 'failing', 'src/fail.test.js']),
    'CLI 产物指纹必须等于导出函数对同一命令的重算（final-gate 正是这样逐 SC 核对）'
  );
  // 命令写法不同但语义相同 → 指纹仍匹配（防「写法变了重跑一下」误拒）
  assert.equal(
    r.verify_fingerprint,
    verifyFingerprint(' vitest ', ['run', '-t', 'failing', ' src/fail.test.js']),
    '边缘空格写法必须重算出同一指纹'
  );
});
