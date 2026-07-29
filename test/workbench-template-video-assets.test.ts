import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import {
  initPathManager,
  resetPathManager,
} from '@forgeax/orchestrator/fs/path-manager';
import { createWorkbenchRouter } from '../src/game/workbench';

let projectRoot: string;
let previousProjectRoot: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-template-assets-'));
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

describe('POST /api/workbench/games template assets', () => {
  test('clones provider-backed assets into the new game scope', async () => {
    const calls: Array<{
      sourceGameDir: string;
      sourceGameId: string;
      targetGameDir: string;
      targetGameId: string;
    }> = [];
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter({
      cloneTemplateAssets: async (input) => {
        expect(existsSync(resolve(input.targetGameDir, 'assets/manifest.json'))).toBe(true);
        calls.push(input);
      },
    }));

    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'nodia-copy',
        name: 'Nodia Copy',
        template: 'game-nodia-fighting',
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceGameId: 'game-nodia-fighting',
      targetGameId: 'nodia-copy',
      targetGameDir: resolve(projectRoot, '.forgeax/games/nodia-copy'),
    });
  });

  test('removes the partial game when asset cloning fails', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter({
      cloneTemplateAssets: async () => {
        throw new Error('copy failed');
      },
    }));

    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'broken-copy',
        template: 'game-nodia-fighting',
      }),
    });

    expect(response.status).toBe(500);
    expect(existsSync(resolve(projectRoot, '.forgeax/games/broken-copy'))).toBe(false);
  });
});
