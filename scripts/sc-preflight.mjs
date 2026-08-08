#!/usr/bin/env node
/**
 * sc-preflight.mjs — task-priority skill 的 SC 预验证器（SC-4）
 *
 * 目标：在派工之前空跑每条 SC 的 verify 命令，拦截「编造的命令」与「空转的 SC」。
 * 实测痛点：mivo-561 两条报告结论被反向验证推翻；bd-disarm 前 10 轮全过、第 17 轮才暴露缺陷。
 *
 * 五态诊断（判成且仅成以下五态之一）：
 *   fabricated      命令不存在 / 不在白名单形状内且也不在 package.json scripts 里 → 编造的命令；
 *                   或 argv 命中拒绝参数（--config/-c/-e/--eval/绝对路径/..）→ 拒绝，不进实跑；
 *                   或空目标（vitest run 无目标路径，防整仓发现）→ 拒绝；
 *                   或目标不是测试文件（不匹配 runner include 规则）/ 目标文件在目标仓不存在 → 拒绝；
 *                   或白名单 cmd 的 argv 形状不匹配 → 拒绝（防「加 flag 绕过实跑」，
 *                   绝不降级到可放行的 exists_not_run；合法但少见形状 → 调整命令或扩白名单）
 *   red_ok          实跑退出码非零 **且** 输出匹配该 runner 的断言失败特征 → 红→绿有意义
 *   green_warn      实跑退出码为零 → 空转嫌疑（这条 SC 现在就绿，证明不了任何事），
 *                   必须由 lead 写 disposition 处置
 *   exists_not_run  重型命令（不在实跑白名单但确在 package.json scripts / devDeps / 磁盘存在，
 *                   或 existsOnly 清单内的 runner）→ 只验存在性；
 *                   目标仓不支持 git worktree add → 降级此态，绝不退化成在主工作树里实跑。
 *                   白名单 cmd 永不落此态（形状不匹配 → fabricated，见上）
 *   infra_fail      非零但特征不符（module not found / config error）、超时、启动失败、
 *                   worktree 内依赖解析不可用（node_modules 暴露失败）、
 *                   或 worktree 清理失败 → fail-closed，不冒充红
 *
 * ★ 保证等级 T1（如实声明，不是沙箱）★
 * 一次性隔离 worktree 只挡「对仓内工作树的意外写入」，**不隔离进程/网络/全局缓存/全局配置**。
 * 措辞统一用「一次性隔离 worktree」，不用「沙箱」或「容器」。
 *
 * 隔离流程（shell:false 不等于安全，真正的边界在这里）：
 *   git worktree add --detach <worktreeTmpRoot>/<随机名> HEAD
 *     → 若 worktree 无 node_modules 且主工作树有：symlink 暴露（运行期依赖解析，见下）
 *     → execFile(cmd, args, {shell:false, cwd: 该 worktree, timeout: preflightTimeoutMs})
 *     → 跑完 git worktree remove --force 并校验已删；删失败 → infra_fail
 *
 * 白名单形状 / existsOnly runner / 拒绝参数 / runner include 规则 / 超时 / worktreeTmpRoot
 * 一律从 config/defaults.json 读取，不硬编码。
 *
 * 用法：
 *   node sc-preflight.mjs --repo <git仓库路径> --cmd <裸程序名> [args...] [--sc-id <SC id>] [--timeout-ms <n>]
 * 输出（stdout，JSON）：
 *   {sc_id, verify_fingerprint, repo_head, status, note, exit_code?, output_sha?, worktree?, disposition?}
 *   note 只记退出码与输出摘要（截断 + sha256），不落原始 stdout 全文。
 *
 * 执行凭据（P0#3）：
 *   - sc_id：CLI --sc-id 透传（receipt 声称验证的对象；final-gate 逐 SC 比对，防张冠李戴）
 *   - verify_fingerprint：本文件导出的确定性指纹（cmd+args 规范化 → sha256 前 16 位），
 *     final-gate 用它核对「当前 manifest 的 verify 命令 == receipt 对应的命令」
 *   - repo_head：跑时的 git rev-parse HEAD，**仅诊断**——rebase 后合法变化，
 *     final-gate 不得把它当等值判据（同 base_sha 的处理）
 */
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.json'), 'utf8'),
);

/**
 * 各 runner 的断言失败特征（代码持有；config 只持白名单形状）。
 * 拿不准某 runner 的断言失败特征 → 该 runner 不进实跑白名单（宁窄勿宽），标 exists_not_run。
 * vitest：断言失败输出行首 × 或 AssertionError（module-not-found 类输出不含，见 infra 区分）
 * tsc：error TS\d+
 */
const FAILURE_PATTERNS = {
  vitest: /(AssertionError|^\s*×\s)/m,
  tsc: /error\s+TS\d+/i,
};

/** cmd 必须裸程序名：禁路径（/）、禁前导 - */
const BARE_CMD_RE = /^[A-Za-z0-9_.-]+$/;

/** flag 值合法形状：字母数字 _ . -（禁空格/引号/路径/脚本注入形态） */
const FLAG_VALUE_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * vitest argv 结构化解析（替代正则形状白名单；F5 形态三修复的一部分）。
 *
 * 语法（与真实 vitest CLI 对齐的**窄**子集）：
 *   `run` [--reporter <name> | --reporter=<name>] [-t <pattern>] <target>
 *   - target：恰好一个位置参数（被测文件路径，相对仓库根）
 *   - --reporter：纯展示 flag（dot/json/verbose…），不改「跑哪些测试、怎么发现测试」，
 *     属 preflightVitestCosmeticFlags 白名单，放行仍实跑
 *   - -t <pattern>：测试名过滤，vitest 既有支持
 *   - 其余任何 token → 形状不匹配。形状不匹配 → fabricated（防绕过，见 diagnose）
 *
 * @returns {{ok:true, target:string|null, pattern:string|null} | {ok:false, reason:string}}
 */
function parseVitestArgs(args) {
  const tokens = [...args];
  if (tokens[0] !== 'run') {
    return { ok: false, reason: `vitest argv 必须以 run 开头（实际 ${tokens[0] ?? '(空)'}）` };
  }
  tokens.shift();
  let target = null;
  let pattern = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '-t') {
      const val = tokens[i + 1];
      if (val === undefined || val.startsWith('-') || !FLAG_VALUE_RE.test(val)) {
        return { ok: false, reason: `-t 需要非空、非 - 开头的裸模式值（实际 ${val ?? '(缺)'}）` };
      }
      pattern = val;
      i++;
      continue;
    }
    if (CONFIG.preflightVitestCosmeticFlags.includes(tok)) {
      // 空格形态：--reporter dot
      const val = tokens[i + 1];
      if (val === undefined || !FLAG_VALUE_RE.test(val)) {
        return { ok: false, reason: `${tok} 需要合法值（实际 ${val ?? '(缺)'}）` };
      }
      i++;
      continue;
    }
    let consumed = false;
    for (const flag of CONFIG.preflightVitestCosmeticFlags) {
      if (tok.startsWith(`${flag}=`)) {
        // 等号形态：--reporter=dot
        const val = tok.slice(flag.length + 1);
        if (!FLAG_VALUE_RE.test(val)) {
          return { ok: false, reason: `${flag}= 需要合法值（实际 ${val}）` };
        }
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    if (tok.startsWith('--') || tok.startsWith('-')) {
      return { ok: false, reason: `未知 flag/参数 "${tok}"` };
    }
    if (target !== null) {
      return { ok: false, reason: `多个位置参数（"${target}" 与 "${tok}"）：vitest 目标只能一个` };
    }
    target = tok;
  }
  return { ok: true, target, pattern };
}

/** vitest 形状判定：解析失败返回原因字符串；解析成功返回 null */
function vitestShapeReason(args) {
  const parsed = parseVitestArgs(args);
  return parsed.ok ? null : parsed.reason;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function shasum(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * verify 命令指纹：cmd + args 规范化 → sha256 前 16 位（P0#3 的判据基础）。
 * 规范化规则（确定性）：cmd trim + 折叠内部空白（程序名不含空白，折叠无副作用）；
 * args 逐项 trim（**不折叠内部空白**——arg 内部空白是语义的，如 -t "a  b"）。
 * 同一命令不同写法（多余边缘空格）→ 同一指纹；不同命令 → 必须不同指纹。
 * 缺省 args 与空数组同指纹（`(args ?? [])` 统一）。
 */
export function verifyFingerprint(cmd, args = []) {
  const normCmd = String(cmd).trim().replace(/\s+/g, ' ');
  const normArgs = (args ?? []).map((a) => String(a).trim());
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ cmd: normCmd, args: normArgs }))
    .digest('hex')
    .slice(0, 16);
}

/** 输出摘要：前 240 字符（换行折叠） + sha256 前 12 位，凭证不落库 */
function outputSummary(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const head = flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
  return head || '(空输出)';
}

function isGitRepo(repo) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** which 探测：cmd 在 PATH 中可解析？ */
function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 读取目标仓 package.json（主工作树），返回 {scripts, deps, devDeps} 键集合 */
function readPackageKeys(repo) {
  try {
    const raw = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return {
      scripts: new Set(Object.keys(pkg.scripts || {})),
      deps: new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]),
    };
  } catch {
    return { scripts: new Set(), deps: new Set() };
  }
}

function runCommand(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 实跑：一次性隔离 worktree 内执行，跑完必删并校验
// ---------------------------------------------------------------------------

/**
 * @returns {{status, note, exit_code?, output_sha?, worktree?}}
 */
async function runInIsolatedWorktree(repo, cmd, args, timeoutMs) {
  const rand = crypto.randomBytes(6).toString('hex');
  const worktreePath = path.join(CONFIG.worktreeTmpRoot, `wt-${rand}`);
  let worktreeCreated = false;

  if (!isGitRepo(repo)) {
    return {
      status: 'exists_not_run',
      note: `目标仓非 git 仓库（${repo}），无法建一次性隔离 worktree，只验存在性（T1 降级）`,
    };
  }

  try {
    fs.mkdirSync(CONFIG.worktreeTmpRoot, { recursive: true });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worktreeCreated = true;
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().replace(/\s+/g, ' ').slice(0, 200);
    return {
      status: 'exists_not_run',
      note: `目标仓不支持 git worktree add，降级只验存在性：${msg}`,
    };
  }

  // PATH 注入：worktree 内的 node_modules/.bin 优先（fixture/提交进 HEAD 的场景），
  // 其次主工作树的 node_modules/.bin（真实目标仓的本地工具链），再继承系统 PATH。
  // cmd 始终是裸程序名，argv 不携带路径。
  const env = {
    ...process.env,
    PATH: [
      path.join(worktreePath, 'node_modules', '.bin'),
      path.join(repo, 'node_modules', '.bin'),
      process.env.PATH || '',
    ].join(path.delimiter),
  };

  // 运行期依赖解析（★ 与项目红线的区分，2026-08-09）：
  // worktree 是 HEAD 快照，没有 node_modules；而 vitest.config.ts 必然 import 'vitest/config'，
  // ESM 只认文件系统路径（不认 NODE_PATH），注入环境变量无效 → 必须在文件系统层面
  // 把主工作树的 node_modules 暴露进 worktree。
  // 项目红线禁的是「用 hardlink/symlink 造**测试夹具**」（2026-08-08 pr-autopilot 真实
  // 配置被 hardlink 穿透改写）。此处不是造夹具：这是运行期依赖解析——symlink 目标即
  // 被测仓自己的 node_modules（依赖树按只读消费，vitest/tsc 不写 node_modules 源码），
  // 不新增任何指向源码/配置的写入路径，worktree 仍一次性、跑完即删。fixture 替身
  // （tests/fixtures/preflight/repo-template）把 node_modules commit 进 HEAD，已存在时
  // 不重复建 symlink（fixture 优先，输出形状受控）。
  // 残余风险（如实声明）：vitest 的 transform 缓存写 node_modules/.vite（gitignore'd、
  // 与本地开发等价）；病态测试若显式写 node_modules 会穿透——这是「命令本身恶意」的
  // 范畴，隔离边界本来就挡不住进程内写入（T1 保证等级）。
  let result = null; // {status, note, exitCode?, outputSha?}
  const worktreeNM = path.join(worktreePath, 'node_modules');
  const repoNM = path.join(repo, 'node_modules');
  if (!fs.existsSync(worktreeNM) && fs.existsSync(repoNM)) {
    try {
      fs.symlinkSync(repoNM, worktreeNM, 'dir');
    } catch (e) {
      result = {
        status: 'infra_fail',
        note: `worktree 内无法暴露主工作树 node_modules（${e.message}）：依赖解析不可用，fail-closed 不实跑`,
      };
    }
  }

  if (result === null) {
    try {
      const { stdout, stderr } = await runCommand(cmd, args, {
        cwd: worktreePath,
        shell: false,
        timeout: timeoutMs,
        env,
      });
      const output = `${stdout}\n${stderr}`;
      if (process.env.SC_PREFLIGHT_DEBUG === '1') {
        process.stderr.write(`[sc-preflight] ${cmd} ${args.join(' ')} exit=0\n${output.slice(0, 400)}\n`);
      }
      result = {
        status: 'green_warn',
        note: `exit=0；输出摘要：${outputSummary(output)}；sha256=${shasum(output)}。空转嫌疑：需要 lead 写 disposition`,
        exit_code: 0,
        output_sha: shasum(output),
      };
    } catch (e) {
      const output = `${e.stdout || ''}\n${e.stderr || ''}`;
      // Node execFile 超时后 err 形态有版本差异：code='ETIMEDOUT' 或 killed=true+signal（SIGTERM）
      if (e.code === 'ETIMEDOUT' || (e.killed && e.signal)) {
        result = {
          status: 'infra_fail',
          note: `超时（${timeoutMs}ms）：exit 未产生，不冒充红`,
          output_sha: shasum(output),
        };
      } else if (e.code === 'ENOENT') {
        result = {
          status: 'infra_fail',
          note: `启动失败：${cmd} 在 worktree 环境不可执行（ENOENT）`,
        };
      } else if (typeof e.code === 'number') {
        // execFile 的 err：退出码非零时可能只出现在 err.code（number），err.exitCode 未必设置
        const exitCode = e.code;
        const pattern = FAILURE_PATTERNS[cmd];
        const matched = pattern ? pattern.test(output) : false;
        if (exitCode !== 0 && matched) {
          result = {
            status: 'red_ok',
            note: `exit=${exitCode}，输出命中 ${cmd} 断言失败特征；输出摘要：${outputSummary(output)}；sha256=${shasum(output)}`,
            exit_code: exitCode,
            output_sha: shasum(output),
          };
        } else {
          // 非零但特征不符（module not found / config error 等）→ infra_fail，不冒充红
          result = {
            status: 'infra_fail',
            note: `exit=${exitCode} 但输出不匹配 ${cmd} 断言失败特征（疑似 infra 类失败，如 module not found / config error）；输出摘要：${outputSummary(output)}；sha256=${shasum(output)}`,
            exit_code: exitCode,
            output_sha: shasum(output),
          };
        }
      } else {
        result = {
          status: 'infra_fail',
          note: `启动/执行失败：${e.code || e.message}`,
        };
      }
    }
  }

  // 清理：跑完必删，删失败 → infra_fail（覆盖先前判定）
  let cleanupFailed = false;
  if (worktreeCreated) {
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktreePath], {
        stdio: 'ignore',
      });
    } catch {
      cleanupFailed = true;
    }
  }
  const removed = !fs.existsSync(worktreePath);
  if (cleanupFailed || !removed) {
    result = {
      status: 'infra_fail',
      note: `worktree 清理失败（已跑命令无法验证隔离边界）${cleanupFailed ? '：git worktree remove 报错' : ''}${removed ? '' : `：${worktreePath} 仍存在`}；原始判定 ${result.status}`,
      exit_code: result.exit_code,
      output_sha: result.output_sha,
    };
  }

  return { ...result, worktree: worktreePath };
}

// ---------------------------------------------------------------------------
// 主流程：五态判定
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  let repo = process.cwd();
  let cmd = null;
  let scId = null;
  let timeoutMs = CONFIG.preflightTimeoutMs;
  const args = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--repo') {
      repo = argv[++i];
    } else if (a === '--cmd') {
      cmd = argv[++i];
    } else if (a === '--sc-id') {
      scId = argv[++i];
    } else if (a === '--timeout-ms') {
      timeoutMs = Number(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      return null;
    } else {
      args.push(a);
    }
    i++;
  }
  return { repo, cmd, args, scId, timeoutMs };
}

/** repo_head：仅诊断（rebase 后合法变化，final-gate 不作等值判据）；取不到 → null */
function repoHead(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function main() {
  const { repo, cmd, args, scId, timeoutMs } = parseArgv(process.argv.slice(2));
  if (!repo || !cmd) {
    process.stderr.write(
      '用法: node sc-preflight.mjs --repo <git仓库路径> --cmd <裸程序名> [args...] [--sc-id <SC id>] [--timeout-ms <n>]\n',
    );
    process.exit(2);
  }

  // 执行凭据统一装饰（所有状态分支都携带）：sc_id / verify_fingerprint / repo_head
  const fp = verifyFingerprint(cmd, args);
  const head = repoHead(repo);
  const wrap = (r) => ({ sc_id: scId ?? null, verify_fingerprint: fp, repo_head: head, ...r });

  const result = diagnose(repo, cmd, args, timeoutMs);
  if (result instanceof Promise) {
    result
      .then((r) => emit(wrap(r)))
      .catch((e) => {
        process.stderr.write(`sc-preflight: 内部错误 ${e.message ?? e}\n`);
        process.exit(2);
      });
  } else {
    emit(wrap(result));
  }
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function diagnose(repo, cmd, args, timeoutMs) {
  // 1) cmd 裸程序名校验
  if (!BARE_CMD_RE.test(cmd) || cmd.startsWith('-')) {
    return {
      status: 'fabricated',
      note: `cmd 必须裸程序名（禁路径、禁前导 -）："${cmd}" 不合法`,
    };
  }

  // 2) existsOnly 清单：node/eslint/npm/npx/playwright/bash 一律只验存在性
  //    （它们最容易加载任意仓库脚本与插件）
  if (CONFIG.preflightExistsOnlyRunners.includes(cmd)) {
    if (commandExists(cmd)) {
      return { status: 'exists_not_run', note: `${cmd} ∈ existsOnly 清单，只验存在性：PATH 中可解析` };
    }
    return { status: 'fabricated', note: `命令不存在：${cmd} 在 PATH 中不可解析` };
  }

  // 3) 实跑白名单形状匹配
  const shape = CONFIG.preflightShapeAllowlist.find((s) => s.cmd === cmd);

  // 逐参数拒绝：--config/-c/-e/--eval/绝对路径/.. → 拒，不进实跑
  const rejectedArg = args.find((a) =>
    CONFIG.preflightRejectArgPatterns.some((p) => new RegExp(p).test(a)),
  );
  if (rejectedArg) {
    return {
      status: 'fabricated',
      note: `拒绝参数 "${rejectedArg}"（命中 preflightRejectArgPatterns），不进实跑`,
    };
  }

  if (shape) {
    // 形状判定：vitest 走结构化解析（形状与语义校验耦合，正则表达不了）；
    // 其余白名单 cmd（tsc）走 config 里的 argvShape 正则。
    // ★ 防绕过（F5 形态三）：白名单 cmd 形状不匹配 → 一律 fabricated，**绝不**降级到
    // 可放行的 exists_not_run。旧行为「形状不符但命令在 deps → exists_not_run」意味着
    // SC 作者给 vitest run 加一个任意 flag 就能跳过实跑、让 final-gate 只验存在性就放行。
    // 代价：合法但形状少见的命令会被拒——这是 fail-safe（大声拒 + 调整命令/扩白名单），
    // 好过静默放行（保证等级从实跑悄悄掉到存在性检查）。常见无害 flag（--reporter 等）
    // 已由 parseVitestArgs 纳入仍实跑，见 preflightVitestCosmeticFlags。
    const shapeReason =
      cmd === 'vitest'
        ? vitestShapeReason(args)
        : new RegExp(shape.argvShape).test(args.join(' '))
          ? null
          : `argv 不合白名单形状（${shape.argvShape}）`;
    if (shapeReason) {
      return {
        status: 'fabricated',
        note: `${cmd} argv 形状不匹配（${shapeReason}）：白名单 cmd 形状不匹配一律拒绝、不降级 exists_not_run（防加 flag 绕过实跑）；合法但少见形状请调整命令或扩展白名单`,
      };
    }

    // 语义校验（vitest）：空目标拒绝 + 目标必须是「真测试」（runner include 规则 + 文件真实存在）
    if (cmd === 'vitest') {
      const { target } = parseVitestArgs(args);
      if (!target) {
        return {
          status: 'fabricated',
          note: '空目标拒绝：vitest run 无目标路径（防整仓发现），不进实跑',
        };
      }
      const includeRe = new RegExp(CONFIG.preflightTestInclude[cmd]);
      if (!includeRe.test(target)) {
        return {
          status: 'fabricated',
          note: `目标路径 "${target}" 不是测试文件（不匹配 ${cmd} include 规则 ${CONFIG.preflightTestInclude[cmd]}），拒绝`,
        };
      }
      if (!fs.existsSync(path.join(repo, target))) {
        return {
          status: 'fabricated',
          note: `目标文件 "${target}" 不存在于目标仓（${repo}），拒绝`,
        };
      }
    }

    // 全过 → 一次性隔离 worktree 实跑
    return runInIsolatedWorktree(repo, cmd, args, timeoutMs);
  }

  // 4) 不在白名单：确在 scripts / devDeps / 磁盘 → exists_not_run；否则 fabricated
  const pkg = readPackageKeys(repo);
  if (pkg.scripts.has(cmd) || pkg.deps.has(cmd) || commandExists(cmd)) {
    return {
      status: 'exists_not_run',
      note: `${cmd} 不在实跑白名单（existsOnly 之外），但确在 ${pkg.scripts.has(cmd) ? 'package.json scripts' : pkg.deps.has(cmd) ? 'package.json deps' : '磁盘'}，只验存在性`,
    };
  }
  return {
    status: 'fabricated',
    note: `命令不存在且不在白名单：${cmd} 无法在 PATH 或 package.json 中解析 → 编造的命令`,
  };
}

// isCLI guard：被 final-gate import 时（P0#3 指纹核对）不执行 CLI 入口，
// 只导出 verifyFingerprint 供重算比对。原无条件 main() 会让 import 即死（process.exit）。
const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCLI) {
  main();
}
