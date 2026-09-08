import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import {
  initPathManager,
  resetPathManager,
} from '@forgeax/orchestrator/fs/path-manager';
import { createProductApiRouter } from '../src/game/product-api';

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

describe('POST /api/projects template assets', () => {
  test('delegates selected-template assets into the new game scope', async () => {
    const calls: Array<{
      sourceGameDir: string;
      sourceGameId: string;
      targetGameDir: string;
      targetGameId: string;
    }> = [];
    const app = new Hono();
    app.route('/api', createProductApiRouter({
      cloneTemplateAssets: async (input) => {
        expect(existsSync(resolve(input.targetGameDir, 'forge.json'))).toBe(true);
        calls.push(input);
      },
    }));

    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'nodia-copy',
        name: 'Nodia Copy',
        template: 'game-empty',
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceGameId: 'game-empty',
      targetGameId: 'nodia-copy',
      targetGameDir: resolve(projectRoot, '.forgeax/games/nodia-copy'),
    });
  });

  test('removes the partial game when asset cloning fails', async () => {
    const app = new Hono();
    app.route('/api', createProductApiRouter({
      cloneTemplateAssets: async () => {
        throw new Error('copy failed');
      },
    }));

    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'broken-copy',
        template: 'game-empty',
      }),
    });

    expect(response.status).toBe(500);
    expect(existsSync(resolve(projectRoot, '.forgeax/games/broken-copy'))).toBe(false);
  });
});
