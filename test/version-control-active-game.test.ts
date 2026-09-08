import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { setActiveGame } from '../src/game/active-game';
import { createActiveGameVersionControlHandler } from '../src/game/version-control';

let root: string;
let previousProjectRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'forgeax-version-control-active-game-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = root;
  mkdirSync(resolve(root, '.forgeax/games/game-a'), { recursive: true });
  resetPathManager();
  initPathManager({ projectRoot: root });
});

afterEach(() => {
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('active-game version-control Host', () => {
  test('rewrites the Studio route to the active game router', async () => {
    setActiveGame(root, 'game-a');
    const handler = createActiveGameVersionControlHandler({ projectRoot: root });

    const response = await handler(new Request('http://studio.test/api/version-control/snapshot'));
    const body = await response.json() as { status?: string; error?: { code?: string } };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'uninitialized',
      error: { code: 'version-control-unavailable' },
    });
  });

  test('forwards command requests to the active game router', async () => {
    setActiveGame(root, 'game-a');
    const handler = createActiveGameVersionControlHandler({ projectRoot: () => root });

    const response = await handler(new Request('http://studio.test/api/version-control/commands/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(503);
    expect((await response.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: 'version-control-unavailable' },
    });
  });
});
