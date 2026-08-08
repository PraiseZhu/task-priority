// probe.mjs 测试 —— 覆盖 SC-P1（满血）/ SC-P2（降级）/ SC-P3（只读）/ SC-P4（确定性）/
// SC-P5（候选池）+ 测试映射 + 热区 + 参数校验。
// fixture 是模板（tests/fixtures/probe/），每个用例在 /tmp 动态 git init + commit，
// 用完即删 —— 不污染任何真实仓库，也不在 skill 目录留下 .git。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(SKILL_ROOT, "tests", "fixtures", "probe");
const PROBE = path.join(SKILL_ROOT, "scripts", "probe.mjs");
const INJECTED_TS = "test-injected-timestamp";

async function run(cmd, args, cwd) {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout) };
  } catch (e) {
    return { code: e.code ?? 1, stdout: String(e.stdout ?? "") };
  }
}

// 把 fixture 模板拷到 /tmp 并 git init + 两个 commit：
//   c1 全部文件（每个文件 commits_14d=1）
//   c2 只 touch src/canvas/useSpike.ts（该文件 commits_14d=2）
async function makeRepo(templateDir) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-fixture-"));
  await fs.cp(templateDir, dir, { recursive: true });
  const cfg = ["-c", "user.name=probe-test", "-c", "user.email=probe-test@example.com"];
  const r1 = await run("git", ["init", "-q"], dir);
  assert.equal(r1.code, 0, "git init 失败");
  // 本机 gitconfig 若开了 commit.gpgsign，夹具 commit 走 gpg 签名——并发下 gpg 内存分配失败
  // 导致整支测试环境性 flake（2026-08-09 实测 Cannot allocate memory），毒化 fail 0 判据。
  // fixture 是本地测试工件，签名无价值，显式关掉保证确定性。
  assert.equal((await run("git", ["config", "commit.gpgsign", "false"], dir)).code, 0, "关 gpg 签名失败");
  assert.equal((await run("git", [...cfg, "add", "-A"], dir)).code, 0);
  assert.equal((await run("git", [...cfg, "commit", "-qm", "c1: initial"], dir)).code, 0);
  await fs.appendFile(path.join(dir, "src", "canvas", "useSpike.ts"), "\n// c2 touch\n");
  assert.equal((await run("git", [...cfg, "add", "-A"], dir)).code, 0);
  assert.equal((await run("git", [...cfg, "commit", "-qm", "c2: touch useSpike"], dir)).code, 0);
  return dir;
}

async function runProbe(repoDir, { paths = [], keywords = [] } = {}) {
  const argv = [PROBE, "--repo-dir", repoDir, "--generated-at-source", INJECTED_TS];
  if (paths.length > 0) argv.push("--paths", paths.join(","));
  if (keywords.length > 0) argv.push("--keywords", keywords.join(","));
  const res = await run(process.execPath, argv, SKILL_ROOT);
  return res;
}

const FULL_PATHS = ["src/render/useLeaferSpikeRenderer.ts", "src/store/index.ts"];

test("SC-P1 满血路径：codemap 存在 → degraded=false 且 impact 非空（模块级反向闭包）", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { paths: FULL_PATHS });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.degraded, false);
  assert.equal(out.degraded_reason, undefined);
  assert.ok(out.impact.length > 0, "impact 为空");

  // 关注路径保留原始路径；referenced_by 为模块级直接引用者；depth 为反向闭包最大深度
  const render = out.impact.find((i) => i.path === "src/render/useLeaferSpikeRenderer.ts");
  assert.ok(render, "缺少 render 关注路径 impact");
  assert.deepEqual(render.referenced_by, ["src/canvas"], `实际: ${JSON.stringify(render.referenced_by)}`);
  assert.equal(render.depth, 3, "canvas←app←src 涟漪应为 3 层");

  const store = out.impact.find((i) => i.path === "src/store/index.ts");
  assert.ok(store, "缺少 store 关注路径 impact");
  assert.deepEqual(store.referenced_by, ["src", "src/app"]);
  // src 无反向引用者、src/app 的唯一引用者 src 已在 depth1 集合内 → 闭包只有 1 层
  assert.equal(store.depth, 1);
});

test("SC-P1 附加：keywords 命中模块职责（desc 含 zustand → src/store）", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { keywords: ["zustand"] });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.degraded, false);
  const hit = out.impact.find((i) => i.path === "src/store");
  assert.ok(hit, "keywords 应命中 src/store 模块");
  assert.deepEqual(hit.referenced_by, ["src", "src/app"]);
});

test("SC-P2 降级路径：无 codemap → degraded=true 且 reason 说清原因，hot_paths/候选池仍可用", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "degraded"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { paths: ["src/render/useLeaferSpikeRenderer.ts"] });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);

  assert.equal(out.degraded, true);
  assert.ok(out.degraded_reason && out.degraded_reason.includes("codemap"), `reason: ${out.degraded_reason}`);

  // 降级仍产出粗粒度引用（git grep，排除自身文件）
  const impact = out.impact.find((i) => i.path === "src/render/useLeaferSpikeRenderer.ts");
  assert.ok(impact, "降级模式仍应产出 impact");
  assert.deepEqual(impact.referenced_by, ["src/canvas/useSpike.ts"], `实际: ${JSON.stringify(impact.referenced_by)}`);

  // 热区与候选池不受降级影响
  assert.ok(out.hot_paths.length > 0, "降级模式 hot_paths 应为空外的可用数据");
  assert.deepEqual(out.available_verify_cmds, ["build", "lint", "test:unit"]);
});

test("SC-P3 只读证明：probe 前后 git status --porcelain 逐字相同（零写入、零 git 状态改动）", async (t) => {
  for (const kind of ["full", "degraded"]) {
    const dir = await makeRepo(path.join(FIXTURES, kind));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    const before = (await run("git", ["status", "--porcelain"], dir)).stdout;
    const res = await runProbe(dir, { paths: FULL_PATHS });
    assert.equal(res.code, 0, res.stdout);
    const after = (await run("git", ["status", "--porcelain"], dir)).stdout;
    assert.equal(after, before, `[${kind}] probe 改变了 git 状态\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
  }
});

test("SC-P4 确定性：同输入连跑两次，输出逐字相同（含注入时间字段）", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const args = { paths: FULL_PATHS, keywords: ["zustand"] };
  const r1 = await runProbe(dir, args);
  const r2 = await runProbe(dir, args);
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(r1.stdout, r2.stdout, "两次输出应逐字相同");
  assert.ok(JSON.parse(r1.stdout).generated_at_source === INJECTED_TS, "注入时间字段应原样透传");
});

test("SC-P5 候选池有效：available_verify_cmds 与 package.json scripts 键集完全一致（防编造命令）", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { paths: FULL_PATHS });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  const expected = Object.keys(pkg.scripts).sort();
  assert.deepEqual(out.available_verify_cmds, expected);
});

test("git 热区：14 天内改动频次 top N，touch 两次的文件排第一", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { paths: FULL_PATHS });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);
  const top = out.hot_paths[0];
  assert.equal(top.path, "src/canvas/useSpike.ts");
  assert.equal(top.commits_14d, 2);
});

test("测试映射：同名 test + 同名 spec + __tests__/ 同级 + git grep 内容引用", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const res = await runProbe(dir, { paths: FULL_PATHS });
  assert.equal(res.code, 0, res.stdout);
  const out = JSON.parse(res.stdout);

  const render = out.test_map.find((m) => m.path === "src/render/useLeaferSpikeRenderer.ts");
  assert.deepEqual(render.candidate_tests, [
    "src/render/__tests__/render-spike.test.ts",
    "src/render/useLeaferSpikeRenderer.test.ts",
  ]);

  const store = out.test_map.find((m) => m.path === "src/store/index.ts");
  assert.deepEqual(store.candidate_tests, ["src/store/index.test.ts"]);
});

test("参数校验：缺 --repo-dir 与绝对路径关注路径均 exit 2（fail-closed）", async (t) => {
  const dir = await makeRepo(path.join(FIXTURES, "full"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const noRepo = await run(process.execPath, [PROBE], SKILL_ROOT);
  assert.equal(noRepo.code, 2, "缺 --repo-dir 应 exit 2");

  const abs = await run(process.execPath, [PROBE, "--repo-dir", dir, "--paths", "/etc/passwd"], SKILL_ROOT);
  assert.equal(abs.code, 2, "绝对路径应 exit 2");

  const dotdot = await run(process.execPath, [PROBE, "--repo-dir", dir, "--paths", "src/../store"], SKILL_ROOT);
  assert.equal(dotdot.code, 2, ".. 路径应 exit 2");
});
