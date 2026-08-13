import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const templateDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('minimal game baseline is capability-light', () => {
  const manifest = JSON.parse(readFileSync(resolve(templateDir, 'forge.json'), 'utf8'));

  assert.equal(manifest.entry, 'main.ts');
  assert.equal(manifest.physics, false);
  assert.equal(existsSync(resolve(templateDir, 'assets')), false);
  assert.equal(existsSync(resolve(templateDir, 'main.ts')), true);
});
