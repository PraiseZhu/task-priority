/**
 * evolution-note.test.mjs — SC-8 三支：
 *   ① 同 fingerprint 二次入账只自增 occurrences（entries 长度不变、occurrences=2）；
 *   ② 默认（无 --sync）调用后：HEAD 不变、index 不变、remote refs 不变、
 *      未调用 add/commit/push、working tree diff 恰好限定在
 *      evolution/ledger.json 与 EVOLUTION.md 两个文件（台账写盘本就该有这两个 diff）；
 *   ③ 对照组：调用前预置一个无关脏文件，调用后断言它未被裹挟进任何 git 操作。
 *
 * 注意断言口径（计划 F29）：**不是「git status 零变化」**——那与写台账自相矛盾。
 * 台账写盘必然产生 ledger.json + EVOLUTION.md 两个 diff，是预期行为。
 *
 * 每个用例一个隔离临时 git 仓库（git init + 初始 commit + fake remote），
 * 经 TASK_PRIORITY_SKILL_ROOT 重定向台账根，绝不碰真台账。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { queryLedger, ledgerFingerprint } from '../scripts/lib/ledger-query.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/evolution-note.mjs');

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** 隔离 git 仓库 fixture：初始 commit（含台账两文件初版）+ fake origin remote。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'task-priority-evo-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@test.local']);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  git(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'evolution'), { recursive: true });
  writeFileSync(join(root, 'evolution', 'ledger.json'), '{"version":1,"entries":[]}\n');
  writeFileSync(join(root, 'EVOLUTION.md'), '# task-priority 自进化台账\n');
  writeFileSync(join(root, 'README.md'), 'placeholder\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);

  // fake remote：本地 bare 仓，用来断言「remote refs 不变」（未 push）。
  const remote = mkdtempSync(join(tmpdir(), 'task-priority-remote-'));
  const bare = join(remote, 'origin.git');
  git(remote, ['init', '--bare', 'origin.git']);
  git(root, ['remote', 'add', 'origin', bare]);

  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, json: JSON.parse(stdout) };
    } catch (e) {
      let json = null;
      try { json = JSON.parse(String(e.stdout ?? '')); } catch { /* 非 JSON 错误输出 */ }
      return { status: e.status ?? 1, json, stderr: String(e.stderr ?? '') };
    }
  };
  const head = () => git(root, ['rev-parse', 'HEAD']);
  const logCount = () => git(root, ['rev-list', '--count', 'HEAD']);
  const cached = () => git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const worktree = () => git(root, ['diff', '--name-only']).split('\n').filter(Boolean);
  const lsRemote = () => git(root, ['ls-remote', 'origin']).split('\n').filter(Boolean);
  return { root, run, head, logCount, cached, worktree, lsRemote, bare };
}

test('SC-8① 同 fingerprint 二次入账只自增 occurrences：entries 长度不变、occurrences=2', () => {
  const { run } = sandbox();
  const args = ['add', '--fingerprint', 'gap-backfill-fork-assumption', '--tier', 'proposal', '--title', 'fork PR 被 fail-closed 拒'];
  const r1 = run(args);
  assert.equal(r1.status, 0);
  assert.equal(r1.json.isNew, true);
  const r2 = run(args);
  assert.equal(r2.status, 0);
  assert.equal(r2.json.isNew, false, '二次入账必须识别为已知根因');
  const ledger = JSON.parse(readFileSync(join(r2.json.ledgerFile), 'utf8'));
  assert.equal(ledger.entries.length, 1, 'entries 长度必须不变（去重）');
  assert.equal(ledger.entries[0].occurrences, 2, 'occurrences 必须自增到 2');
});

test('SC-8② 默认（无 --sync）调用后零对外副作用：HEAD/index/remote 不变、无新 commit、diff 恰好限于台账两文件', () => {
  const { run, head, logCount, cached, worktree, lsRemote } = sandbox();
  const headBefore = head();
  const countBefore = logCount();
  const remoteBefore = lsRemote();
  assert.deepEqual(remoteBefore, [], 'fixture 初始 remote 无 refs');

  const r = run(['add', '--fingerprint', 'prediction-blindspot', '--tier', 'auto', '--title', '清单未预测到的 finding']);
  assert.equal(r.status, 0);
  assert.equal(r.json.sync.skipped, 'no-sync-default', '默认路径必须显式标注未同步（红线一：无 --sync 完全不碰 git）');

  assert.equal(head(), headBefore, 'HEAD 必须不变');
  assert.equal(logCount(), countBefore, '不得产生新 commit（未调用 add/commit）');
  assert.deepEqual(cached(), [], 'index 必须不变（未 add）');
  assert.deepEqual(lsRemote(), remoteBefore, 'remote refs 必须不变（未 push）');

  const dirty = worktree().sort();
  assert.deepEqual(
    dirty,
    ['EVOLUTION.md', 'evolution/ledger.json'].sort(),
    'working tree diff 必须恰好限于 ledger.json 与 EVOLUTION.md（台账写盘本就该有这两个 diff）'
  );
});

test('SC-8③ 对照组：预置无关脏文件，调用后未被裹挟进任何 git 操作', () => {
  const { root, run, head, logCount, cached } = sandbox();
  // 预置无关脏文件：tracked 的 README.md 改脏 + untracked 的 notes.txt
  writeFileSync(join(root, 'README.md'), 'placeholder\nEDITED-BY-CONTROL\n');
  writeFileSync(join(root, 'notes.txt'), 'untracked dirty file\n');
  const statusBefore = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).sort();

  const headBefore = head();
  const countBefore = logCount();
  const r = run(['add', '--fingerprint', 'control-group', '--tier', 'auto', '--title', '对照组']);
  assert.equal(r.status, 0);

  assert.equal(head(), headBefore, 'HEAD 必须不变');
  assert.equal(logCount(), countBefore, '不得产生新 commit');
  assert.deepEqual(cached(), [], 'index 必须为空：无关脏文件不得被 add/commit 裹挟');

  const statusAfter = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).sort();
  // README.md 保持 modified（不被 add/commit）、notes.txt 保持 untracked、台账两文件出现 diff —— 三者并存
  assert.ok(statusAfter.some((s) => s.startsWith(' M ') && s.includes('README.md')), 'README.md 必须保持未暂存修改状态');
  assert.ok(statusAfter.some((s) => s.startsWith('??') && s.includes('notes.txt')), 'notes.txt 必须保持 untracked');
  assert.ok(!statusAfter.some((s) => s.includes('README.md') && s.startsWith('M ')), 'README.md 不得被裹挟进 index');
  // 无关文件的状态行数不变（两个脏文件行 + 台账两行 diff），仅台账新增两行
  assert.equal(statusAfter.length, statusBefore.length + 2, '除台账两个文件外，工作树状态必须原样');
});

test('默认路径在非 git 仓（SKILL_ROOT 不在 git 内）也能正常写台账：git 副作用自然为零', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-priority-evo-plain-'));
  mkdirSync(join(root, 'evolution'), { recursive: true });
  writeFileSync(join(root, 'evolution', 'ledger.json'), '{"version":1,"entries":[]}\n');
  const r = (() => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, 'add', '--fingerprint', 'plain-dir', '--tier', 'auto', '--title', 't'], {
        encoding: 'utf8',
        env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, json: JSON.parse(stdout) };
    } catch (e) {
      return { status: e.status ?? 1, stderr: String(e.stderr ?? '') };
    }
  })();
  assert.equal(r.status, 0, '非 git 仓下默认调用必须成功（台账写入不依赖 git）');
  assert.equal(r.json.sync.skipped, 'no-sync-default');
  const ledger = JSON.parse(readFileSync(join(root, 'evolution', 'ledger.json'), 'utf8'));
  assert.equal(ledger.entries.length, 1);
  assert.ok(existsSync(join(root, 'EVOLUTION.md')), 'EVOLUTION.md 必须再生成');
});

test('add 缺 fingerprint/tier/title 与非法 fingerprint 均拒（fail-closed）', () => {
  const { run } = sandbox();
  assert.equal(run(['add', '--tier', 'auto', '--title', 't']).status, 1, '缺 fingerprint 拒');
  assert.equal(run(['add', '--fingerprint', 'BAD_SLUG', '--tier', 'auto', '--title', 't']).status, 1, '非法 fingerprint（大写）拒');
  assert.equal(run(['add', '--fingerprint', 'ab', '--tier', 'auto', '--title', 't']).status, 1, '过短 fingerprint 拒');
  assert.equal(run(['add', '--fingerprint', 'ok-slug', '--title', 't']).status, 1, '缺 tier 拒');
  assert.equal(run(['add', '--fingerprint', 'ok-slug', '--tier', 'bogus', '--title', 't']).status, 1, '非法 tier 拒');
  assert.equal(run(['add', '--fingerprint', 'ok-slug', '--tier', 'auto']).status, 1, '缺 title 拒');
});

test('set-status 更新条目状态并带 note；未知 fingerprint 拒', () => {
  const { run } = sandbox();
  run(['add', '--fingerprint', 'status-test', '--tier', 'auto', '--title', 't', '--commit', 'abc123']);
  const r = run(['set-status', '--fingerprint', 'status-test', '--status', 'landed', '--note', '已复核']);
  assert.equal(r.status, 0);
  assert.equal(r.json.entry.status, 'landed');
  assert.equal(r.json.entry.note, '已复核');
  assert.equal(r.json.sync.skipped, 'no-sync-default');
  assert.equal(run(['set-status', '--fingerprint', 'no-such', '--status', 'landed']).status, 1, '未知 fingerprint 拒');
});

// ─────────────────────────────────────────────────────────────────────────────
// ledger-query 消费入口（P2 修复：自进化台账只有写入、无消费闭环）——
// 四支反向变异（断言口径「恰好等于」而非「包含」）+ fail-closed 五支。
// 全走真实 CLI（node scripts/lib/ledger-query.mjs + TASK_PRIORITY_SKILL_ROOT 重定向），
// 不只看纯函数。
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/lib/ledger-query.mjs');

/** 隔离台账根：只写 evolution/ledger.json（TASK_PRIORITY_SKILL_ROOT 重定向），绝不碰真台账。 */
function ledgerSandbox(entries, { noFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-priority-ledger-query-'));
  if (!noFile) {
    mkdirSync(join(root, 'evolution'), { recursive: true });
    writeFileSync(join(root, 'evolution', 'ledger.json'), JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  }
  const run = () => {
    try {
      const stdout = execFileSync(process.execPath, [QUERY_SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, json: JSON.parse(stdout) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
  };
  return { root, run };
}

const makeEntry = (fingerprint, occurrences, extra = {}) => ({
  fingerprint,
  tier: 'proposal',
  title: 't',
  detail: null,
  proposal: null,
  status: 'open',
  commit: null,
  note: null,
  occurrences,
  firstSeen: '2026-08-01T00:00:00.000Z',
  lastSeen: '2026-08-08T00:00:00.000Z',
  ...extra,
});

test('ledger-query 反向变异① 空台账 → status 恰好等于 BOOTSTRAP_EMPTY_LEDGER（不是静默空数组）', () => {
  const { run } = ledgerSandbox([]);
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'BOOTSTRAP_EMPTY_LEDGER', '空台账必须显式标注 BOOTSTRAP，不得给空数组伪装成已查过');
  assert.equal(r.json.entries, 0);
  assert.deepEqual(r.json.top_occurrences, [], 'BOOTSTRAP 态 top_occurrences 恰好为空数组');
  assert.match(r.json.fingerprint, /^ledger-[0-9a-f]{10}$/, '空台账也必须有确定性快照 fingerprint');
});

test('ledger-query 反向变异② 临时台账新增一条逃逸 → 输出恰好出现该 fingerprint', () => {
  const { run } = ledgerSandbox([makeEntry('esc-1234567890', 1)]);
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.json.status, 'OK');
  assert.equal(r.json.entries, 1);
  assert.equal(r.json.top_occurrences.length, 1, '一条逃逸恰好产出一条弹药');
  assert.equal(r.json.top_occurrences[0].fingerprint, 'esc-1234567890', '输出必须恰好携带该条目的 fingerprint');
  assert.equal(r.json.top_occurrences[0].occurrences, 1);
  assert.equal(r.json.top_occurrences[0].tier, 'proposal');
});

test('ledger-query 反向变异③ 同一 ledger 跑两次 → 输出逐字节相同（byte-identical）', () => {
  const entries = [makeEntry('esc-aaa', 2), makeEntry('esc-bbb', 5), makeEntry('esc-ccc', 1)];
  const { run } = ledgerSandbox(entries);
  const r1 = run();
  const r2 = run();
  assert.equal(r1.status, 0);
  assert.equal(r2.status, 0);
  assert.equal(r1.stdout, r2.stdout, '同一 ledger 两次查询输出必须逐字节相同');
});

test('ledger-query 反向变异④ 条目顺序打乱后输入 → 输出仍逐字节相同（排序稳定，不靠插入序）', () => {
  const entriesA = [makeEntry('esc-aaa', 2), makeEntry('esc-bbb', 5), makeEntry('esc-ccc', 1)];
  const entriesB = [entriesA[2], entriesA[0], entriesA[1]]; // 乱序（ccc 在前）
  const s1 = ledgerSandbox(entriesA);
  const s2 = ledgerSandbox(entriesB);
  const r1 = s1.run();
  const r2 = s2.run();
  assert.equal(r1.status, 0);
  assert.equal(r2.status, 0);
  assert.equal(r1.stdout, r2.stdout, '乱序输入必须产出逐字节相同的输出（含 ledger fingerprint）');
  assert.deepEqual(
    r1.json.top_occurrences.map((o) => o.fingerprint),
    ['esc-bbb', 'esc-aaa', 'esc-ccc'],
    '排序恰好为：频次降序（5→2→1）',
  );
});

test('ledger-query 变异⑤ 同频条目按 fingerprint 升序（恰好相等，不靠插入序）', () => {
  const entries = [makeEntry('esc-zeta', 3), makeEntry('esc-alpha', 3), makeEntry('esc-mid', 3)];
  const { run } = ledgerSandbox(entries);
  const r = run();
  assert.equal(r.status, 0);
  assert.deepEqual(
    r.json.top_occurrences.map((o) => o.fingerprint),
    ['esc-alpha', 'esc-mid', 'esc-zeta'],
    '同频必须按 fingerprint 字典序升序（localeCompare 确定序）',
  );
});

test('ledger-query 变异⑥ 损坏台账 fail-closed：JSON 无法解析 → exit 2（读侧不静默吞错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-priority-ledger-bad-'));
  mkdirSync(join(root, 'evolution'), { recursive: true });
  writeFileSync(join(root, 'evolution', 'ledger.json'), '{not-json!!\n');
  let r;
  try {
    execFileSync(process.execPath, [QUERY_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    r = { status: 0 };
  } catch (e) {
    r = { status: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
  assert.equal(r.status, 2, '损坏台账必须 fail-closed（exit 2），不得当空台账起步');
  assert.match(r.stderr, /ledger-query FAIL/, 'stderr 必须点名失败原因');
});

test('ledger-query 变异⑦ entries 非数组（结构非法）→ exit 2；纯函数 queryLedger 对非法输入 throw', () => {
  assert.throws(() => queryLedger({ version: 1, entries: 'oops' }), /entries 必须是数组/, '纯函数必须拒绝非数组 entries');
  assert.throws(() => queryLedger(null), /entries 必须是数组/, '纯函数必须拒绝 null');
  const root = mkdtempSync(join(tmpdir(), 'task-priority-ledger-badshape-'));
  mkdirSync(join(root, 'evolution'), { recursive: true });
  writeFileSync(join(root, 'evolution', 'ledger.json'), '{"version":1,"entries":"oops"}\n');
  let r;
  try {
    execFileSync(process.execPath, [QUERY_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    r = { status: 0 };
  } catch (e) {
    r = { status: e.status ?? 1, stderr: String(e.stderr ?? '') };
  }
  assert.equal(r.status, 2, 'entries 非数组必须 fail-closed');
});

test('ledger-query 变异⑧ ledger 文件不存在 → BOOTSTRAP_EMPTY_LEDGER（「还没开始积累」而非报错）', () => {
  const { run } = ledgerSandbox([], { noFile: true });
  const r = run();
  assert.equal(r.status, 0);
  assert.equal(r.json.status, 'BOOTSTRAP_EMPTY_LEDGER', '文件缺失 = 尚未开始积累，与空数组同样语义');
  assert.equal(r.json.entries, 0);
});

test('ledger-query 变异⑨ ledger fingerprint 顺序无关：纯函数对乱序 entries 产出相同指纹', () => {
  const a = { version: 1, entries: [makeEntry('esc-x', 1), makeEntry('esc-y', 2)] };
  const b = { version: 1, entries: [makeEntry('esc-y', 2), makeEntry('esc-x', 1)] };
  assert.equal(ledgerFingerprint(a), ledgerFingerprint(b), 'fingerprint 必须与条目顺序无关');
  assert.equal(ledgerFingerprint(a), 'ledger-' + ledgerFingerprint(a).slice(7), 'fingerprint 自洽');
});
