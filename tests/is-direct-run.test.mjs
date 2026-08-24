import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectRun } from '../scripts/lib/is-direct-run.mjs';

test('isDirectRun: 经软链调用仍判定为直接运行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idr-'));
  const real = join(dir, 'real.mjs');
  const link = join(dir, 'link.mjs');
  writeFileSync(real, 'export {}\n');
  symlinkSync(real, link);
  const meta = pathToFileURL(real).href;
  assert.equal(isDirectRun(meta, link), true);
  assert.equal(isDirectRun(meta, real), true);
  assert.equal(isDirectRun(meta, join(dir, 'other.mjs')), false);
  rmSync(dir, { recursive: true, force: true });
});
