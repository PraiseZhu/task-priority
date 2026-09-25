// tests/vendor-integrity.test.mjs — vendored 判据源（vendor/pr-autopilot）完整性。
//
// 判据源从外部仓原样导出后随本仓走，防三类漂移：
//   ① 文件被手改（逐文件 sha256 ≡ VENDOR.json）；
//   ② 多出/少了文件（目录内文件集 ≡ VENDOR.json.files 键集）；
//   ③ 闭包不自足（每条相对 import 都落在 vendor 内且存在），否则运行期会悄悄回退依赖外部路径。
// 以及默认配置确实指向这份副本、且解析后不依赖归档仓。
//
// 运行：cd <SKILL_ROOT> && node --test tests/vendor-integrity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAuthority, resolveAuthorityRoot } from '../scripts/lib/authority.mjs';

const SKILL_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_ROOT = path.join(SKILL_ROOT, 'vendor', 'pr-autopilot');
const MANIFEST = JSON.parse(readFileSync(path.join(VENDOR_ROOT, 'VENDOR.json'), 'utf8'));

// helpers
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function toRel(abs) {
  return path.relative(VENDOR_ROOT, abs).split(path.sep).join('/');
}

test('vendor ①: 每个文件的 sha256 与 VENDOR.json 一致', () => {
  for (const [rel, expected] of Object.entries(MANIFEST.files)) {
    const actual = createHash('sha256').update(readFileSync(path.join(VENDOR_ROOT, rel))).digest('hex');
    assert.equal(actual, expected, `${rel} 被改过：期望 ${expected}，实际 ${actual}（只能从源仓重新导出）`);
  }
});

test('vendor ②: 目录内文件集与 VENDOR.json 完全一致', () => {
  const onDisk = walk(VENDOR_ROOT).map(toRel).filter((f) => f !== 'VENDOR.json').sort();
  assert.deepEqual(onDisk, Object.keys(MANIFEST.files).sort());
});

test('vendor ③: 所有相对 import 都在 vendor 内解析成功', () => {
  const importRe = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
  for (const rel of Object.keys(MANIFEST.files).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(path.join(VENDOR_ROOT, rel), 'utf8');
    for (const m of src.matchAll(importRe)) {
      const target = path.resolve(path.dirname(path.join(VENDOR_ROOT, rel)), m[1]);
      assert.ok(!path.relative(VENDOR_ROOT, target).startsWith('..'), `${rel} import ${m[1]} 越出 vendor`);
      assert.ok(existsSync(target), `${rel} import ${m[1]} 在 vendor 内缺失`);
    }
  }
});

test('vendor ④: 默认配置指向 vendor 副本，loadAuthority 从它加载成功', async () => {
  const cfg = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'config', 'defaults.json'), 'utf8'));
  assert.equal(resolveAuthorityRoot(cfg.prAutopilotRoot), VENDOR_ROOT);
  const authority = await loadAuthority();
  assert.equal(authority.FACES.length, 7);
});

test('registry_path ⑤: 规范相对路径/本机绝对路径/历史根可接受，换 registry 或任意路径一律拒', async () => {
  const { registryPathMatches, LEGACY_AUTHORITY_ROOTS } = await import('../scripts/lib/authority.mjs');
  const authority = await loadAuthority();
  const info = authority.resolveUiRegistry('xindong/mivo-canvas');
  assert.equal(info.rel, 'scripts/ui-paths/registry.mivo.json');
  assert.equal(info.path, path.join(VENDOR_ROOT, info.rel));

  assert.ok(registryPathMatches(info.rel, info), '规范相对路径');
  assert.ok(registryPathMatches(info.path, info), '本机绝对路径');
  for (const root of LEGACY_AUTHORITY_ROOTS) {
    assert.ok(registryPathMatches(`${root}/${info.rel}`, info), `历史根 ${root}`);
    assert.ok(!registryPathMatches(`${root}/scripts/ui-paths/registry.cindy.json`, info), '历史根下换 registry');
  }
  assert.ok(!registryPathMatches('scripts/ui-paths/registry.cindy.json', info), '换 registry');
  assert.ok(!registryPathMatches(`/tmp/evil/${info.rel}`, info), '任意根下的同名文件');
  assert.ok(!registryPathMatches(undefined, info), '非字符串');
});
