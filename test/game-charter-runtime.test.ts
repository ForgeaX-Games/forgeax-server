import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const profile of ['web-dev', 'desktop-dev', 'desktop-prod']) {
  test(`loads the game charter from the ${profile} resource layout`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-charter-'));
    try {
      if (profile === 'desktop-prod') {
        const assets = join(root, 'server-runtime/assets');
        mkdirSync(assets, { recursive: true });
        writeFileSync(join(assets, 'game-charter.md'), 'packaged {{serverPort}} {{interfacePort}}');
      }
      const entry = resolve(import.meta.dir, '../src/game/game-charter.ts');
      const result = spawnSync(process.execPath, ['-e',
        `import { buildGameCharter } from ${JSON.stringify(entry)}; console.log(buildGameCharter({serverPort:'48900', interfacePort:'48920'}));`,
      ], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, FORGEAX_STARTUP_PROFILE: profile, FORGEAX_RESOURCE_ROOT: root },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('48920');
      if (profile === 'desktop-prod') expect(result.stdout.trim()).toBe('packaged 48900 48920');
      else expect(result.stdout).not.toContain('packaged 48900');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
