#!/usr/bin/env node
/**
 * run-tests.mjs — task-priority skill 测试的单一权威入口
 *
 * 背景（真实缺陷，2026-08-09）：本 skill 179 支测试的正确运行命令一度没写进任何文档，
 * 而两种直觉写法都给假红——`node --test tests/` 一支都没跑却报红（Node 24.13 把目录
 * 位置参数当脚本执行），裸 `node --test` 自动发现会把 tests/fixtures/** 下的夹具当真
 * 测试收走（6 支假红）。本入口把「显式枚举 tests/*.test.mjs」固化成一个可执行命令，
 * 文档只指到这里。
 *
 * 实现要点：
 *   - 显式枚举 tests/ 顶层的 *.test.mjs（绝不递归、绝不自动发现），夹具目录天然不进入；
 *   - 输出是 node test runner 的原始 stdout/stderr（stdio: inherit），不做任何重新统计；
 *   - 退出码 = node --test 的退出码：全绿 0 / 有红非 0（信号终止按失败计）。
 *   - 只用 node: 内置模块，零依赖。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');

const testFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(testsDir, f));

if (testFiles.length === 0) {
  console.error(`run-tests: no *.test.mjs found in ${testsDir} — nothing to run`);
  process.exit(2);
}

const res = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });

if (res.error) {
  console.error(`run-tests: failed to spawn ${process.execPath}: ${res.error.message}`);
  process.exit(2);
}
// status === null 表示被信号终止，按失败计（不能当 0）
process.exit(res.status === null ? 1 : res.status);
