import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { createWorkbenchRouter } from '../src/game/workbench';

let projectRoot: string;
let previousProjectRoot: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-create-game-default-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  initPathManager({ projectRoot });
});

afterEach(() => {
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/workbench/games engine default', () => {
  test('creates from engine/templates/game-default when there is no project override', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter());
    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'engine-start', name: 'Engine Start' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/engine-start');
    const manifest = JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8')) as {
      id?: string;
      name?: string;
      entry?: string;
      physics?: unknown;
      defaultScene?: string;
    };
    expect(manifest).toMatchObject({
      id: 'engine-start',
      name: 'Engine Start',
      entry: 'main.ts',
      physics: '3d',
    });
    expect(manifest.defaultScene).toMatch(/^[0-9a-f-]{36}$/);

    const scenePackPath = resolve(gameDir, 'assets/scene.pack.json');
    expect(existsSync(scenePackPath)).toBe(true);
    expect(existsSync(resolve(gameDir, 'src/scene-runtime.ts'))).toBe(true);
    expect(readFileSync(resolve(gameDir, 'main.ts'), 'utf8')).toContain('@forgeax/engine-render');

    const scenePack = JSON.parse(readFileSync(scenePackPath, 'utf8')) as {
      assets?: Array<{ guid?: string; kind?: string }>;
    };
    const scene = scenePack.assets?.find((asset) => asset.kind === 'scene');
    expect(scene?.guid).toBe(manifest.defaultScene);
  });
});
