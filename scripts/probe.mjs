#!/usr/bin/env node
// task-priority skill — 影响面探测器（工作流 Phase 1 数据抓取，kind=probe SC 的数据源）。
//
// 四路只读探测：
//   1. 反向依赖（影响面）：目标仓有 scripts/codemap.mjs 时调用它取模块图，解析出关注路径的
//      「被谁引用」（codemap --full 的 `←` 反向列表）；没有/跑不动 → 降级 git grep + glob
//      粗粒度扫描，并如实标 degraded: true（不把粗粒度结果装成满血反向依赖）。
//   2. git 热区：git log --since=14.days --name-only 统计改动频次 top N（撞车预警）。
//   3. 测试映射：对关注路径找可能覆盖它的测试文件（同名 .test./.spec.、__tests__/ 同级、
//      git grep 内容引用）。
//   4. 可用验证命令枚举：读目标仓 package.json 的 scripts 键集 —— 后续 SC 的 verify 只能
//      从候选池挑选（防编造命令）。
//
// 纪律（硬）：
//   - 严格只读：不写目标仓任何文件、不改目标仓 git 状态（不 checkout/stash/commit）。
//   - 零依赖：只用 node: 内置模块 + git/node 子进程；execFile(shell:false)。
//   - 确定性：不自取系统时间（generated_at_source 由调用方经 --generated-at-source 注入，
//     缺省为 null）；输出键序固定、数组排序去重，同输入两次输出逐字相同。
//
// 用法：
//   node scripts/probe.mjs --repo-dir <目标仓> [--paths a,b,c] [--keywords k1,k2]
//       [--generated-at-source "<调用方注入的时间文本，缺省 null>"]
//       [--out <路径>]
//
// stdout 只输出最终 JSON（机器消费）；stderr 打人类可读提示。
// --out 把与 stdout 相同的 JSON 原子写入该路径（tmp+rename）；缺省仍只 stdout。
// 约定路径 ~/.claude/.goal/<slug>/probe.json 由调用方传入，脚本不猜 slug。

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep, posix } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HOT_TOP_N = 10;
const TEST_GLOB_PATHS = [
  ":(glob)**/*.test.*",
  ":(glob)**/*.spec.*",
  ":(glob)**/__tests__/**",
];
// 遍历文件树时跳过这些目录（.git 必跳；缓存/构建产物不进测试映射）
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);

// ── CLI 解析（手写，零依赖）──
function parseArgs(argv) {
  const out = { repoDir: null, paths: [], keywords: [], generatedAtSource: null, outPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少值`);
      return argv[++i];
    };
    if (a === "--repo-dir") out.repoDir = next();
    else if (a === "--paths") out.paths = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--keywords") out.keywords = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--generated-at-source") out.generatedAtSource = next();
    else if (a === "--out") out.outPath = next();
    else if (a === "--help" || a === "-h") {
      console.error(
        "用法: node scripts/probe.mjs --repo-dir <目标仓> [--paths a,b,c] [--keywords k1,k2] [--generated-at-source <文本>] [--out <路径>]"
      );
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!out.repoDir) throw new Error("缺少必填参数 --repo-dir");
  return out;
}

// ── 子进程（shell:false 零 shell 注入）──
async function run(cmd, args, cwd) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) };
  }
}

// ── 路径规范化：repo-relative POSIX，拒绝对路径/`..`/NUL ──
function normalizePath(p) {
  if (typeof p !== "string" || p.length === 0) throw new Error("关注路径为空");
  if (p.includes("\0")) throw new Error(`关注路径含 NUL: ${p}`);
  let q = p.replace(/\\/g, "/").replace(/^\.\//, "");
  while (q.endsWith("/")) q = q.slice(0, -1);
  if (q.startsWith("/") || q.split("/").includes("..")) {
    throw new Error(`关注路径必须为 repo-relative POSIX（拒绝绝对路径/..）: ${p}`);
  }
  return q;
}

// ── ① codemap：满血反向依赖 ──
// 解析目标仓 scripts/codemap.mjs --full 的模块级 markdown：
//   - **NAME** — nf nL — 职责
//     - → dep1, dep2, ...
//     - ← rev1, rev2, ...
// 返回 Map<name, {deps: string[], revs: string[], desc: string}>。
function parseCodemap(text) {
  const modules = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\s*-\s*\*\*(.+?)\*\*\s*—/);
    if (m) {
      const name = m[1].trim();
      cur = { name, deps: [], revs: [], desc: line.slice(m[0].length).trim() };
      modules.set(name, cur);
      continue;
    }
    if (!cur) continue;
    const rev = line.match(/^\s*-\s*←\s*(.+)$/);
    if (rev) {
      // `—` 是 codemap 的空列表占位符，必须解析为空数组（否则会变成假节点）
      cur.revs = rev[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "—");
      continue;
    }
    const dep = line.match(/^\s*-\s*→\s*(.+)$/);
    if (dep) cur.deps = dep[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "—");
  }
  return modules;
}

// 关注路径 → 模块归属（精确匹配优先，否则最长前缀）。
function moduleOf(path, modules) {
  if (modules.has(path)) return path;
  let best = null;
  for (const name of modules.keys()) {
    if (path.startsWith(name + "/") && (best === null || name.length > best.length)) best = name;
  }
  return best;
}

// BFS 沿反向边求闭包：直接引用者（depth 1）、引用者的引用者（depth 2）……
// 返回 { direct: string[], maxDepth: number }。maxDepth=0 表示无人引用。
function reverseClosure(root, modules) {
  const rootMod = modules.get(root);
  if (!rootMod) return { direct: [], maxDepth: 0 };
  const depth = new Map([[root, 0]]);
  const queue = [root];
  let maxDepth = 0;
  while (queue.length > 0) {
    const m = queue.shift();
    const d = depth.get(m);
    const revs = modules.get(m)?.revs ?? [];
    for (const r of revs) {
      if (depth.has(r)) continue;
      depth.set(r, d + 1);
      if (d + 1 > maxDepth) maxDepth = d + 1;
      queue.push(r);
    }
  }
  depth.delete(root);
  const direct = [...depth.keys()].filter((k) => depth.get(k) === 1).sort();
  return { direct, maxDepth };
}

// keywords 命中：模块名或职责描述（小写不敏感）包含关键词 → 纳入关注。
function keywordHits(keywords, modules) {
  const hits = new Set();
  for (const [name, mod] of modules) {
    const hay = (name + " " + mod.desc).toLowerCase();
    for (const kw of keywords) {
      if (hay.includes(kw.toLowerCase())) hits.add(name);
    }
  }
  return [...hits].sort();
}

// 降级：无 codemap 时用 git grep 做粗粒度引用扫描（如实标 degraded）。
async function grepReferencedBy(repoDir, paths, keywords) {
  const impact = [];
  const scan = async (selfPath, pattern) => {
    const res = await run("git", ["grep", "-l", "-F", "--", pattern], repoDir);
    if (res.code !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .filter((s) => s !== selfPath) // 排除关注路径自身（其内容天然含自身符号名）
      .filter((s) => !/\.test\.|\.spec\./.test(s) && !s.includes("/__tests__/"))
      .sort();
  };
  for (const p of paths) {
    const base = p.split("/").pop().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    const refs = await scan(p, base);
    impact.push({ path: p, referenced_by: refs, depth: refs.length > 0 ? 1 : 0 });
  }
  for (const kw of keywords) {
    const refs = await scan(kw, kw);
    impact.push({ path: kw, referenced_by: refs, depth: refs.length > 0 ? 1 : 0 });
  }
  return impact;
}

// ── ② git 热区 ──
async function gitHotPaths(repoDir) {
  const res = await run("git", ["log", "--since=14.days", "--name-only", "--pretty=format:"], repoDir);
  if (res.code !== 0) return [];
  const counts = new Map();
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("commit ")) continue;
    if (line.includes("\0")) continue;
    const q = line.replace(/\\/g, "/");
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, n]) => ({ path, commits_14d: n }))
    .sort((a, b) => b.commits_14d - a.commits_14d || a.path.localeCompare(b.path))
    .slice(0, HOT_TOP_N);
}

// ── ③ 测试映射 ──
// 文件树 glob（零依赖手写遍历）找测试文件。
function walkFiles(root, rel = "") {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walkFiles(root, r));
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}
const isTestFile = (p) => /(\.test\.|\.spec\.)/.test(p) || p.includes("/__tests__/");

async function testMap(repoDir, paths) {
  const files = walkFiles(repoDir).sort();
  const testFiles = files.filter(isTestFile);
  const map = [];
  for (const p of paths) {
    const candidates = new Set();
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const base = p.split("/").pop();
    const stem = base.replace(/(\.test\.|\.spec\.).*$/, "").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    const ext = base.match(/\.(tsx?|jsx?|mjs|cjs)$/)?.[1] ?? "ts";
    const prefix = dir ? `${dir}/` : "";
    // 同名 .test./.spec.（同目录）
    for (const t of testFiles) {
      if (t === `${prefix}${stem}.test.${ext}` || t === `${prefix}${stem}.spec.${ext}`) {
        candidates.add(t);
      }
    }
    // 目录级关注：该目录树下所有测试文件
    if (statSync(join(repoDir, p), { throwIfNoEntry: false })?.isDirectory()) {
      for (const t of testFiles) if (t.startsWith(p + "/")) candidates.add(t);
    }
    // __tests__/ 同级同名（如 src/render/__tests__/foo.test.ts 覆盖 src/render/foo.ts）
    for (const t of testFiles) {
      if (t.startsWith(`${prefix}__tests__/`) && t.includes(stem)) candidates.add(t);
    }
    // git grep 内容引用（固定字符串：先全路径去扩展名，再 basename 去扩展名）
    for (const pattern of [`${p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")}`, stem]) {
      if (pattern.length === 0) continue;
      const res = await run("git", ["grep", "-l", "-F", "--", pattern, ...TEST_GLOB_PATHS], repoDir);
      if (res.code !== 0) continue;
      for (const t of res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        candidates.add(t);
      }
    }
    map.push({ path: p, candidate_tests: [...candidates].sort() });
  }
  return map;
}

// ── ④ scripts 候选池 ──
function enumerateScripts(repoDir) {
  const pkgPath = join(repoDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const keys = Object.keys(pkg.scripts ?? {});
  return [...keys].sort();
}

// canonical_repo 离线派生（git remote get-url origin → owner/name 规范化；失败 null）
async function canonicalRepo(repoDir) {
  const res = await run("git", ["remote", "get-url", "origin"], repoDir);
  if (res.code !== 0) return null;
  const url = res.stdout.trim();
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// ── main ──
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[probe] 参数错误: ${e.message}`);
    process.exit(2);
  }
  const repoDir = args.repoDir;
  if (!existsSync(repoDir)) {
    console.error(`[probe] --repo-dir 不存在: ${repoDir}`);
    process.exit(2);
  }
  let paths = [];
  try {
    paths = args.paths.map(normalizePath);
  } catch (e) {
    console.error(`[probe] ${e.message}`);
    process.exit(2);
  }
  if (args.generatedAtSource === null) {
    console.error("[probe] 提示: 未注入 --generated-at-source，输出 generated_at_source=null（调用方应注入以保持可复现）");
  }

  const out = {
    repo_dir: repoDir,
    canonical_repo: null,
    generated_at_source: args.generatedAtSource,
    degraded: false,
    impact: [],
    hot_paths: [],
    test_map: [],
    available_verify_cmds: [],
  };
  out.canonical_repo = await canonicalRepo(repoDir);

  // ── ① 反向依赖 ──
  const codemapPath = join(repoDir, "scripts", "codemap.mjs");
  let modules = null;
  let codemapErr = null;
  if (existsSync(codemapPath)) {
    const res = await run(process.execPath, ["scripts/codemap.mjs", "--full"], repoDir);
    if (res.code !== 0) {
      codemapErr = `scripts/codemap.mjs 运行失败 (exit ${res.code}): ${res.stderr.slice(0, 200)}`;
    } else {
      modules = parseCodemap(res.stdout);
      if (modules.size === 0) codemapErr = "scripts/codemap.mjs 输出未能解析出模块表（格式可能已变更）";
    }
  } else {
    codemapErr = "目标仓无 scripts/codemap.mjs";
  }

  if (modules && codemapErr === null) {
    // 满血：关注路径 → 模块归属 → 反向闭包（path 保留原始关注路径，引用者为模块级）
    const seen = new Set();
    const pushImpact = (entry) => {
      if (seen.has(entry.path)) return;
      seen.add(entry.path);
      out.impact.push(entry);
    };
    for (const p of paths) {
      const m = moduleOf(p, modules);
      if (m) {
        const { direct, maxDepth } = reverseClosure(m, modules);
        pushImpact({ path: p, referenced_by: direct, depth: maxDepth });
      } else {
        // 路径不属于任何模块：降级为粗粒度 grep，如实记录（不装成模块级结论）
        const res = await run("git", ["grep", "-l", "-F", "--", p.split("/").pop().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")], repoDir);
        const refs = res.code === 0
          ? res.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && s !== p).sort()
          : [];
        pushImpact({ path: p, referenced_by: refs, depth: refs.length > 0 ? 1 : 0 });
      }
    }
    for (const kw of args.keywords) {
      const mods = keywordHits([kw], modules);
      if (mods.length > 0) {
        for (const m of mods) {
          const { direct, maxDepth } = reverseClosure(m, modules);
          pushImpact({ path: m, referenced_by: direct, depth: maxDepth });
        }
      } else {
        // 关键词没命中任何模块：仍给一条粗粒度 grep 证据（不装成模块级结论）
        const res = await run("git", ["grep", "-l", "-F", "--", kw], repoDir);
        const refs = res.code === 0
          ? res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort()
          : [];
        pushImpact({ path: kw, referenced_by: refs, depth: refs.length > 0 ? 1 : 0 });
      }
    }
    out.impact.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    // 降级（如实标 degraded）
    out.degraded = true;
    out.degraded_reason = codemapErr ?? "codemap 不可用";
    out.impact = await grepReferencedBy(repoDir, paths, args.keywords);
  }

  // ── ② 热区 ──
  out.hot_paths = await gitHotPaths(repoDir);

  // ── ③ 测试映射（依赖真实文件树 + git grep，与 codemap 无关）──
  if (paths.length > 0) out.test_map = await testMap(repoDir, paths);

  // ── ④ 候选池 ──
  out.available_verify_cmds = enumerateScripts(repoDir);

  const json = JSON.stringify(out, null, 2) + "\n";
  if (args.outPath) {
    const dest = args.outPath;
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, dest);
  }
  process.stdout.write(json);
}

main().catch((e) => {
  console.error(`[probe] 意外错误: ${e.stack ?? e.message}`);
  process.exit(1);
});
