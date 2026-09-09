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

test('bootstrap uses the public Studio contract and declares its imports', () => {
  const entry = readFileSync(resolve(templateDir, 'main.ts'), 'utf8');
  const { dependencies } = JSON.parse(readFileSync(resolve(templateDir, 'package.json'), 'utf8'));
  const imports = [...entry.matchAll(/import type \{ (\w+) \} from '([^']+)'/g)];
  assert.deepEqual(imports.map(([, name, source]) => [name, source]), [
    ['BootstrapContext', '@forgeax/editor-game-plugins'],
    ['World', '@forgeax/engine-ecs'],
  ]);
  for (const [, , source] of imports) assert.equal(dependencies[source], 'workspace:*');
});
