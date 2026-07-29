import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gameHostBeforeVersion,
  gameHostSeedProvider,
  syncComponentsExcludingTests,
} from '../src/game/game-host-hooks';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('syncComponentsExcludingTests', () => {
  test('preserves identical files while updating changed and stale entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-components-sync-'));
    roots.push(root);
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    await mkdir(join(src, 'nested'), { recursive: true });
    await mkdir(join(src, '__tests__'), { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(join(src, 'stable.ts'), 'same');
    await writeFile(join(src, 'changed.ts'), 'new');
    await writeFile(join(src, 'nested', 'child.ts'), 'child');
    await writeFile(join(src, '__tests__', 'ignored.test.ts'), 'ignored');
    await writeFile(join(dest, 'stable.ts'), 'same');
    await writeFile(join(dest, 'changed.ts'), 'old');
    await writeFile(join(dest, 'stale.ts'), 'stale');
    await writeFile(join(dest, 'nested'), 'old file shape');

    const stableBefore = (await stat(join(dest, 'stable.ts'))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await syncComponentsExcludingTests(src, dest);

    expect((await stat(join(dest, 'stable.ts'))).mtimeMs).toBe(stableBefore);
    expect(await readFile(join(dest, 'changed.ts'), 'utf8')).toBe('new');
    expect(await readFile(join(dest, 'nested', 'child.ts'), 'utf8')).toBe('child');
    expect(await Bun.file(join(dest, 'stale.ts')).exists()).toBe(false);
    expect(await Bun.file(join(dest, '__tests__', 'ignored.test.ts')).exists()).toBe(false);
  });
});

describe('video game host hooks', () => {
  test('clones the canonical media into the target game before returning the seed', async () => {
    const targetGameDir = await mkdtemp(join(tmpdir(), 'forgeax-video-seed-'));
    roots.push(targetGameDir);
    await mkdir(join(targetGameDir, 'assets'), { recursive: true });

    const seed = await gameHostSeedProvider(
      { slug: 'target-game', targetGameDir },
      async (input) => {
        expect(input.sourceGameId).toBe('game-nodia-fighting');
        expect(input.targetGameId).toBe('target-game');
        expect(input.targetGameDir).toBe(targetGameDir);
        await writeFile(
          join(targetGameDir, 'assets', 'manifest.json'),
          JSON.stringify({
            version: 2,
            assets: [{
              id: 'video-1',
              kind: 'video',
              provider: { type: 'cos', key: 'games/target-game/video/video-1.mp4' },
            }],
          }),
        );
      },
    );

    expect(seed.project).toMatchObject({
      id: 'target-game',
      platform: 'wb-game-video',
    });
    expect(seed.assetsManifest).toMatchObject({
      assets: [{
        provider: { key: 'games/target-game/video/video-1.mp4' },
      }],
    });
  });

  test('stamps the game type when preparing the initial video version', async () => {
    const gameDir = await mkdtemp(join(tmpdir(), 'forgeax-video-version-'));
    roots.push(gameDir);
    await writeFile(
      join(gameDir, 'forge.json'),
      JSON.stringify({ id: 'target-game', name: 'Target Game' }),
    );

    await gameHostBeforeVersion({
      slug: 'target-game',
      gameDir,
      project: { platform: 'wb-game-video' },
    });

    expect(JSON.parse(await readFile(join(gameDir, 'forge.json'), 'utf8')))
      .toMatchObject({ projectType: 'game-video' });
  });
});
