/**
 * gap-backfill.test.mjs — SC-10 十四支（计划核心机制 D 的五道依序检查 + 对账）。
 *
 * 测试基建：
 *   - 每用例独立构建 fixture 目录（manifest + plan + artifact + receipt + 台账根），
 *     artifact 的 consensus_artifact_hash 用**权威** recomputeArtifactHash 现算
 *     （消费 pr-autopilot，不自造实现），receipt 双 hash 用 lib/hashing 现算。
 *   - fixture git 仓库（cwd 运行 gap-backfill）：origin remote 指向本地 fake bare 仓，
 *     URL 用 ssh 形态（git@github.com:xindong/mivo-canvas.git），canonicalRepo 离线派生。
 *   - gh 一律走 fixtures/ledger/gh-stub.mjs（GAP_BACKFILL_GH 注入），不真查 GitHub。
 *   - 台账根 TASK_PRIORITY_SKILL_ROOT 重定向到临时目录，绝不碰真台账。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recomputeArtifactHash } from '/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot/scripts/consensus-gate.mjs';
import { manifestCoreHash, planHash } from '../scripts/lib/hashing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../scripts/gap-backfill.mjs');
const GH_STUB = resolve(HERE, 'fixtures/ledger/gh-stub.mjs');

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const SLUG = 'test-plan-2026-08-08';
const REPO = 'xindong/mivo-canvas';
const BRANCH = 'feat/ledger';
const PR_NUMBER = 42;
const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROUND = 1;

/** 一份合法的 consensus artifact（consensus_artifact_hash 由权威现算）。 */
function makeArtifact({ findings, prNumber = PR_NUMBER, baseSha = BASE_SHA, round = ROUND } = {}) {
  const artifact = {
    schema_version: 'v3',
    review_input_hash: 'x'.repeat(64),
    base_sha: baseSha,
    candidate_sha: 'b'.repeat(40),
    canonical_findings: findings,
    verdict_hashes: ['v'.repeat(64), 'v'.repeat(64), 'v'.repeat(64)],
    consensus_artifact_hash: '0'.repeat(64),
    created_at: '2026-08-08T12:00:00.000Z',
    gate_result: 'pass',
    round,
    parent_artifact_hash: null,
    pr_number: prNumber,
    fail_reasons: [],
  };
  artifact.consensus_artifact_hash = recomputeArtifactHash(artifact);
  return artifact;
}

const finding = (canonicalKey, primaryFace, invariant, severity = 'major') => ({
  canonical_key: canonicalKey,
  primary_face: primaryFace,
  invariant,
  severity,
  anchor: 'src/store.ts',
  status: 'open',
  origins: [{ reviewer: 'seat1', finding_id: 'F1' }],
  family_key: 'fk1-' + 'f'.repeat(62),
  origin_family_ids: ['F1'],
});

/** 命中组（清单预测集恰好覆盖）与逃逸组（预测集外）。 */
const HIT_FINDINGS = [
  finding('f1', 'A', 'State Single Writer'),
  finding('f2', 'D', 'Delete needs reconciliation'),
];
const ESCAPE_FINDING = finding('f3', 'B', 'Sync defaults must be flipped');

function makeManifest({ scs }) {
  return {
    schema_version: '1',
    slug: SLUG,
    goal: 'test goal',
    context_refs: [],
    priorities: [{ id: 'p1', title: 't', why: 'w', pr_split: { suggested_prs: 1, functional_pr: true } }],
    scs,
    coverage: [],
  };
}

const SCS = [
  {
    id: 'sc-1', priority_id: 'p1', kind: 'fix', granularity: 'assertion',
    change: 'c', holds: 'h', verify: { cmd: 'echo ok', args: [] }, expect: 'ok',
    anchor_paths: ['src/a.ts'], faces: ['A'], predicted_invariant: 'State Single Writer', predicted_primary_face: 'A',
  },
  {
    id: 'sc-2', priority_id: 'p1', kind: 'fix', granularity: 'assertion',
    change: 'c', holds: 'h', verify: { cmd: 'echo ok', args: [] }, expect: 'ok',
    anchor_paths: ['src/b.ts'], faces: ['D'], predicted_invariant: 'Delete needs reconciliation', predicted_primary_face: 'D',
  },
  {
    id: 'sc-3', priority_id: 'p1', kind: 'verify', granularity: 'assertion',
    change: 'c', holds: 'h', verify: { cmd: 'echo ok', args: [] }, expect: 'ok',
    anchor_paths: ['src/c.ts'], faces: ['B'],
  },
];

function makeReceipt({ manifest, planText, canonicalRepo = REPO, branch = BRANCH, prNumber = PR_NUMBER, baseSha = BASE_SHA, slug = SLUG }) {
  return {
    slug,
    manifest_core_hash: manifestCoreHash(manifest),
    plan_hash: planHash(planText),
    canonical_repo: canonicalRepo,
    branch,
    pr_number: prNumber,
    binding_strength: prNumber != null ? 'strong' : 'weak',
    base_sha: baseSha,
    released_at: '2026-08-08T12:00:00.000Z',
  };
}

/**
 * 完整 fixture：
 *   - fixtureDir：manifest/plan/artifact/receipt 落盘
 *   - repoDir：git 仓库（cwd），origin remote = ssh 形态 URL（离线派生 canonical_repo）
 *   - ledgerRoot：台账根（TASK_PRIORITY_SKILL_ROOT 重定向）
 */
function makeFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-priority-gap-'));
  const fixtureDir = join(root, 'fixture');
  const ledgerRoot = join(root, 'ledger');
  const repoDir = join(root, 'repo');
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(join(ledgerRoot, 'evolution'), { recursive: true });
  writeFileSync(join(ledgerRoot, 'evolution', 'ledger.json'), '{"version":1,"entries":[]}\n');

  // git 仓库 + origin（fake bare remote，URL 用 ssh 形态）
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.name', 'test']);
  git(repoDir, ['config', 'user.email', 'test@test.local']);
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  git(repoDir, ['checkout', '-b', BRANCH]);
  writeFileSync(join(repoDir, 'README.md'), 'x\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', 'init']);
  const bare = join(root, 'origin.git');
  git(root, ['init', '--bare', 'origin.git']);
  git(repoDir, ['remote', 'add', 'origin', `git@github.com:${overrides.remoteRepo ?? REPO}.git`]);

  const manifest = overrides.manifest ?? makeManifest({ scs: SCS });
  const planText = overrides.planText ?? '# test plan\n\n## 正文\n\nbody\n';
  const artifact = overrides.artifact ?? makeArtifact({ findings: [...HIT_FINDINGS, ESCAPE_FINDING] });
  const receipt = overrides.receipt ?? makeReceipt({ manifest, planText });

  const manifestPath = join(fixtureDir, 'task-manifest.json');
  const planPath = join(fixtureDir, 'priority-plan.md');
  const artifactPath = join(fixtureDir, 'consensus-artifact.json');
  const receiptPath = join(fixtureDir, 'release-receipt.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(planPath, planText);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  const run = (extraArgs = [], { ghBin = GH_STUB, ghEnv = {}, cwd = repoDir, expectManifestHash = null } = {}) => {
    const args = [
      SCRIPT,
      '--manifest', manifestPath,
      '--plan', planPath,
      '--artifact', artifactPath,
      '--receipt', receiptPath,
      '--expect-manifest-hash', expectManifestHash ?? manifestCoreHash(manifest),
      ...extraArgs,
    ];
    try {
      const stdout = execFileSync(process.execPath, args, {
        encoding: 'utf8',
        cwd,
        env: { ...process.env, TASK_PRIORITY_SKILL_ROOT: ledgerRoot, GAP_BACKFILL_GH: ghBin, ...ghEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, json: JSON.parse(stdout) };
    } catch (e) {
      let json = null;
      try { json = JSON.parse(String(e.stdout ?? '')); } catch { /* 非 JSON 错误输出 */ }
      return { status: e.status ?? 2, json, stderr: String(e.stderr ?? ''), stdout: String(e.stdout ?? '') };
    }
  };
  const readLedger = () => JSON.parse(readFileSync(join(ledgerRoot, 'evolution', 'ledger.json'), 'utf8'));
  return { run, readLedger, manifestPath, planPath, artifactPath, receiptPath, fixtureDir, ledgerRoot, repoDir, manifest, planText, artifact, receipt };
}

test('SC-10① 预测命中不入账：全部 canonical findings 都在预测集内 → 台账零新增', () => {
  const fx = makeFixture({ artifact: makeArtifact({ findings: HIT_FINDINGS }) });
  const r = fx.run();
  assert.equal(r.status, 0);
  assert.equal(r.json.reconciliation.hits, 2);
  assert.equal(r.json.reconciliation.escapes, 0);
  assert.deepEqual(fx.readLedger().entries, [], '命中必须不入账');
  assert.deepEqual(r.json.manual_review, [], '无逃逸时人工复核段为空');
});

test('SC-10② 真逃逸入账：预测集外 finding → ledger 新增 1 条 + 进人工复核段', () => {
  const fx = makeFixture();
  const r = fx.run();
  assert.equal(r.status, 0);
  assert.equal(r.json.reconciliation.hits, 2);
  assert.equal(r.json.reconciliation.escapes, 1);
  assert.equal(r.json.manual_review.length, 1, '未命中项必须进人工复核段列全');
  assert.equal(r.json.manual_review[0].canonical_key, 'f3');
  assert.equal(r.json.manual_review[0].invariant, 'Sync defaults must be flipped');
  const ledger = fx.readLedger();
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].occurrences, 1);
  assert.equal(ledger.entries[0].tier, 'proposal', '逃逸入账默认 proposal（处理策略等维护者拍板）');
  assert.ok(ledger.entries[0].fingerprint.startsWith('esc-'), 'fingerprint 必须以 esc- 前缀');
});

test('SC-10③ 重复逃逸 occurrences 自增：同 artifact 跑两遍 → entries 长度不变、occurrences=2', () => {
  const fx = makeFixture();
  assert.equal(fx.run().status, 0);
  const r2 = fx.run();
  assert.equal(r2.status, 0);
  const ledger = fx.readLedger();
  assert.equal(ledger.entries.length, 1, '重复逃逸必须去重（fingerprint 相同）');
  assert.equal(ledger.entries[0].occurrences, 2, 'occurrences 必须自增');
});

test('SC-10④ 旧 receipt（slug/hash 不匹配当前产物）拒：receipt.slug ≠ manifest.slug → 检查① exit 2', () => {
  const fx = makeFixture({ receipt: makeReceipt({ manifest: makeManifest({ scs: SCS }), planText: '# p\n', slug: 'other-plan-slug' }) });
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查①/);
  assert.match(r.stderr, /slug/);
});

test('SC-10④b 旧 receipt（manifest hash 过期——manifest 已被改但 receipt 未重算）→ 检查① exit 2', () => {
  const baseManifest = makeManifest({ scs: SCS });
  const changedManifest = makeManifest({ scs: [...SCS, { ...SCS[0], id: 'sc-extra', change: 'changed-body' }] });
  const fx = makeFixture({
    manifest: changedManifest,
    // receipt 基于**旧** manifest 算的 hash——落盘 manifest 是新的，receipt 未重算 → 过期
    receipt: makeReceipt({ manifest: baseManifest, planText: '# test plan\n\n## 正文\n\nbody\n' }),
  });
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查①/);
  assert.match(r.stderr, /manifest_core_hash/);
});

test('SC-10⑤ manifest hash 不符拒：--expect-manifest-hash 传错值 → 检查② exit 2', () => {
  const fx = makeFixture();
  const r = fx.run([], { expectManifestHash: '0'.repeat(64) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查②/);
});

test('SC-10⑥ 改 canonical_findings 未重算 hash 拒：篡改 invariant 但 consensus_artifact_hash 不变 → 检查③ exit 2', () => {
  const fx = makeFixture();
  // 篡改 artifact：改 finding 内容但不重算 hash（模拟「改了内容却忘了重算」）
  const tampered = { ...fx.artifact, canonical_findings: fx.artifact.canonical_findings.map((f) => (f.canonical_key === 'f3' ? { ...f, invariant: 'Totally different invariant' } : f)) };
  writeFileSync(fx.artifactPath, JSON.stringify(tampered, null, 2) + '\n');
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查③/);
});

test('SC-10⑦ artifact 分支 ≠ receipt.branch 拒：gh stub 返回不同 headRefName → 检查④ exit 2', () => {
  const fx = makeFixture();
  const r = fx.run([], { ghEnv: { GH_STUB_HEAD_REF: 'other-branch' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查④/);
  assert.match(r.stderr, /headRefName/);
});

test('SC-10⑧ 另一仓同 PR 号 + 同分支名仍拒：headRepositoryOwner ≠ canonical_repo owner → 检查④ exit 2', () => {
  const fx = makeFixture();
  // 模拟从错误仓运行：gh 反查到的是另一个仓的 PR（同号、同名分支），head owner 不同
  const r = fx.run([], { ghEnv: { GH_STUB_HEAD_OWNER: 'other-org', GH_STUB_HEAD_REF: BRANCH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查④/);
  assert.match(r.stderr, /headRepositoryOwner/);
});

test('SC-10⑨ 当前仓身份 ≠ receipt.canonical_repo 拒：fixture 仓 remote 是别的仓 → 离线检查① exit 2（不依赖 gh）', () => {
  const fx = makeFixture({ remoteRepo: 'other/repo' });
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查①/);
  assert.match(r.stderr, /canonical_repo/);
});

test('SC-10⑩ null pr_number 未加 --allow-weak-binding 拒：artifact.pr_number=null → 检查④ 弱绑定被拒', () => {
  const fx = makeFixture({ artifact: makeArtifact({ findings: HIT_FINDINGS, prNumber: null }) });
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查④/);
  assert.match(r.stderr, /allow-weak-binding/);
});

test('SC-10⑪ gh 缺失时走 weak 分支：离线派生的检查①仍能通过；--allow-weak-binding 后成功且标注弱绑定', () => {
  const fx = makeFixture();
  const r = fx.run(['--allow-weak-binding'], { ghBin: '/nonexistent/gh' });
  assert.equal(r.status, 0, 'gh 缺失时必须能走通 weak 降级路径（F38：降级路径真实可执行）');
  assert.equal(r.json.binding.strength, 'weak');
  assert.match(r.json.binding.reason, /gh 不可用/);
  assert.equal(r.json.checks['1_identity_freshness'].ok, true, '检查①离线派生必须仍通过');
  assert.equal(r.json.checks['4_repo_branch_binding'].weak, true);
  // 对账照常执行（逃逸仍入账）
  assert.equal(r.json.reconciliation.escapes, 1);
  assert.equal(fx.readLedger().entries.length, 1);
});

test('SC-10⑫ fork PR（head owner ≠ base owner）拒：v1 不支持 fork，fail-closed', () => {
  const fx = makeFixture();
  const r = fx.run([], { ghEnv: { GH_STUB_HEAD_OWNER: 'forked-user', GH_STUB_HEAD_REF: BRANCH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查④/);
  assert.match(r.stderr, /headRepositoryOwner/);
});

test('SC-10⑬ 吃原始 verdict 拒：非 consensus artifact（无自洽 hash 的 verdict 形状）→ 检查③ exit 2', () => {
  const fx = makeFixture();
  // 原始 verdict 形状：无 consensus_artifact_hash 自洽性（recomputeArtifactHash 对结构非法输入 throw）
  const rawVerdict = {
    reviewer: 'seat1',
    verdict: 'APPROVED',
    findings: [{ finding_id: 'F1', invariant: 'State Single Writer', primary_face: 'A' }],
  };
  writeFileSync(fx.artifactPath, JSON.stringify(rawVerdict, null, 2) + '\n');
  const r = fx.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /检查③/, '吃原始 verdict 必须被 artifact 自洽检查拦下（输入只认 consensus artifact）');
});

test('SC-10⑭ base_sha 不符只提示不阻断：receipt.base_sha ≠ artifact.base_sha → exit 0 + 人工复核提示', () => {
  const fx = makeFixture({
    artifact: makeArtifact({ findings: HIT_FINDINGS, baseSha: 'c'.repeat(40) }), // rebase 后合法变化
  });
  const r = fx.run();
  assert.equal(r.status, 0, 'base_sha 不等值检查必须假拒绝 rebase 后的合法变化，只提示不阻断');
  assert.ok(r.json.notes.some((n) => n.includes('base_sha')), 'notes 必须含 base_sha 诊断提示');
  assert.ok(r.json.checks['1_identity_freshness'].ok);
});

test('--expect-round 显式声明轮次：与 artifact.round 不符拒（同 PR 跨轮需显式声明）', () => {
  const fx = makeFixture();
  const r = fx.run(['--expect-round', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expect-round/);
  const ok = fx.run(['--expect-round', String(ROUND)]);
  assert.equal(ok.status, 0);
});

test('逃逸入账遵守台账零对外副作用：gap-backfill 跑完后 ledger 的 sync 为 no-sync-default', () => {
  const fx = makeFixture();
  const r = fx.run();
  assert.equal(r.status, 0);
  assert.equal(r.json.ledger.sync.skipped, 'no-sync-default', '逃逸入账不得触发任何 git 同步（默认零对外副作用）');
});
