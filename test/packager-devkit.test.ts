import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebPackager } from '../src/game/packager/platforms/WebPackager';
import { engineDevkitCliPath } from '../src/game/packager/engine-roots';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WebPackager Engine DevKit boundary', () => {
  test('delegates a game build to the selected public CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-devkit-packager-'));
    tempRoots.push(root);
    const engineRoot = join(root, 'engine');
    const gameDir = join(root, 'game');
    const outDir = join(root, 'out');
    mkdirSync(join(engineRoot, 'packages', 'devkit', 'dist'), { recursive: true });
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), '{"name":"@forgeax/engine"}\n');
    writeFileSync(join(gameDir, 'forge.json'), '{"id":"demo","name":"Demo","entry":"main.ts"}\n');
    writeFileSync(join(gameDir, 'package.json'), '{"name":"demo","private":true}\n');
    writeFileSync(join(gameDir, 'main.ts'), 'export default {}\n');

    const cli = engineDevkitCliPath(engineRoot);
    writeFileSync(
      cli,
      `#!/usr/bin/env bun
const { mkdirSync } = await import('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out-dir') + 1];
mkdirSync(out, { recursive: true });
await Bun.write(join(out, 'index.html'), '<!doctype html>');
await Bun.write(join(out, 'forgeax-dist.json'), '{}');
console.log(JSON.stringify({ schemaVersion: '1.0.0', command: 'build', ok: true, value: {} }));
function join(...parts) { return parts.reduce((a, b) => a.replace(/\\/$/, '') + '/' + b.replace(/^\\//, '')); }
`,
    );
    chmodSync(cli, 0o755);

    const result = await new WebPackager().build({
      slug: 'demo',
      gameDir,
      projectRoot: root,
      outDir,
      platform: 'web',
      engineRoot,
    });

    expect(result).toMatchObject({
      ok: true,
      slug: 'demo',
      platform: 'web',
      outDir,
      runHint: '/play/demo/',
    });
  });
});
