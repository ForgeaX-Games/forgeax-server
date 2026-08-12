import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

test('minimal game baseline is capability-light', () => {
  const manifest = JSON.parse(readFileSync(resolve('forge.json'), 'utf8'));

  assert.equal(manifest.entry, 'main.ts');
  assert.equal(manifest.physics, false);
  assert.equal(existsSync(resolve('assets')), false);
  assert.equal(existsSync(resolve('main.ts')), true);
});
