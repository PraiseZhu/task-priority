// lib/repo-identity.mjs — canonical_repo 离线派生（计划 F38-B）。
//
// 从 `git remote get-url origin` 确定性规范化得 `owner/name`，release 与 gap-backfill
// 两侧复用同一函数。**gh 不在此路径上**——本文件只依赖 git 本地命令，完全离线。
// 支持 ssh（`git@github.com:owner/name.git`）与 https（`https://github.com/owner/name.git`）
// 两种 remote URL 形态，均归一成 `owner/name`。
import { execFileSync } from 'node:child_process';

/**
 * 纯函数：把一条 remote URL 归一成 `owner/name`。供测试直接验证两种形态，
 * 也供 canonicalRepo 复用。
 */
export function normalizeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) {
    throw new Error('REPO_IDENTITY_UNREACHABLE: remote url 为空');
  }
  let rest = remoteUrl.trim();
  if (rest.endsWith('.git')) rest = rest.slice(0, -'.git'.length);

  let ownerName;
  if (rest.includes('://')) {
    // https://github.com/owner/name（或 ssh://git@host/owner/name）
    const u = new URL(rest);
    ownerName = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } else if (rest.includes('@') && rest.includes(':')) {
    // ssh: git@github.com:owner/name
    ownerName = rest.slice(rest.lastIndexOf(':') + 1);
  } else {
    ownerName = rest;
  }

  const parts = ownerName.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`REPO_IDENTITY_UNREACHABLE: 无法从 remote url 派生 owner/name: ${remoteUrl}`);
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * canonical_repo：从 cwd 所在仓的 origin remote 离线派生 `owner/name`。
 * 任何 git 读取失败（非 git 仓 / 无 origin）→ 抛错（fail-closed，不猜值）。
 */
export function canonicalRepo({ cwd } = {}) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(`REPO_IDENTITY_UNREACHABLE: git remote get-url origin 失败: ${e.message}`);
  }
  return normalizeRemoteUrl(url);
}
