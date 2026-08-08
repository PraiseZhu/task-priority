#!/usr/bin/env node
// gh-stub.mjs — gap-backfill 测试用的 gh CLI stub（禁止真查 GitHub）。
// 行为由环境变量控制：
//   GH_STUB_HEAD_REF   输出的 headRefName（默认 'feat/ledger'）
//   GH_STUB_HEAD_OWNER 输出的 headRepositoryOwner（默认 'xindong'）
//   GH_STUB_EXIT       非空 → 以非零退出（模拟 gh 查询失败，fail-closed 路径）
// 输出形态对齐 `gh pr view <n> --repo <repo> --json headRefName,headRepositoryOwner`。
const env = process.env;
if (env.GH_STUB_EXIT) {
  console.error('stub gh: forced failure');
  process.exit(1);
}
const headRefName = env.GH_STUB_HEAD_REF ?? 'feat/ledger';
const headRepositoryOwner = env.GH_STUB_HEAD_OWNER ?? 'xindong';
console.log(JSON.stringify({ headRefName, headRepositoryOwner }));
