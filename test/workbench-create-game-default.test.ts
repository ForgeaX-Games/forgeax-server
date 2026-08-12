import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { createGameTemplatesRouter, createWorkbenchRouter } from '../src/game/workbench';

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

describe('POST /api/workbench/games capability-light default', () => {
  test('lists engine-owned templates and creates the selected engine template', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter({ cloneTemplateAssets: async () => {} }));
    app.route('/api/game-templates', createGameTemplatesRouter());

    const catalogResponse = await app.request('/api/workbench/templates');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      templates?: Array<{ slug?: string; name?: string }>;
    };
    expect(catalog.templates).toEqual(expect.arrayContaining([
      { slug: 'game-default', name: 'Default' },
      { slug: 'game-empty', name: 'Empty' },
    ]));

    const publicCatalogResponse = await app.request('/api/game-templates');
    expect(publicCatalogResponse.status).toBe(200);
    expect(await publicCatalogResponse.json()).toEqual(catalog);

    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'selected-engine-template', name: 'Selected', template: 'game-empty' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/selected-engine-template');
    expect(readFileSync(resolve(gameDir, 'main.ts'), 'utf8')).toContain('bootstrap');
    expect(JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8'))).toMatchObject({
      id: 'selected-engine-template',
      name: 'Selected',
    });
  });

  test('creates a minimal project without showcase assets or generated scripts', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter());
    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'engine-start', name: 'Engine Start' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/engine-start');
    const manifest = JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'engine-start',
      name: 'Engine Start',
      entry: 'main.ts',
      physics: false,
    });
    expect(manifest).not.toHaveProperty('defaultScene');
    expect(readdirSync(gameDir).sort()).toEqual([
      'AGENTS.md', 'FORGE.md', 'forge.json', 'items.json', 'main.ts', 'package.json', 'tests',
    ]);
    expect(existsSync(resolve(gameDir, 'assets'))).toBe(false);
    expect(existsSync(resolve(gameDir, 'tests/baseline.test.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(gameDir, 'package.json'), 'utf8'))).toMatchObject({
      scripts: { test: 'node --test tests/baseline.test.mjs' },
    });
    expect(readFileSync(resolve(gameDir, 'main.ts'), 'utf8')).not.toContain('generate-assets');
  });
});
