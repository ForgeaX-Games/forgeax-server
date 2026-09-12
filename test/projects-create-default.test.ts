import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { createProductApiRouter } from '../src/game/product-api';

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

describe('POST /api/projects capability-light default', () => {
  test('lists engine-owned templates and creates the selected engine template', async () => {
    const app = new Hono();
    app.route('/api', createProductApiRouter({ cloneTemplateAssets: async () => {} }));

    const catalogResponse = await app.request('/api/projects/templates');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as {
      templates?: Array<{ slug?: string; name?: string }>;
    };
    expect(catalog.templates).toEqual(expect.arrayContaining([
      { slug: 'game-default', name: 'Default' },
      { slug: 'game-empty', name: 'Empty' },
    ]));

    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'selected-engine-template', name: 'Selected', template: 'game-empty' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/selected-engine-template');
    const manifest = JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8')) as { entry: string };
    const main = readFileSync(resolve(gameDir, manifest.entry), 'utf8');
    // The editor-owned empty template is a capability-light Plugin entrypoint;
    // keep this assertion tied to that public shape rather than the retired
    // bootstrap function used by older engine template revisions.
    expect(main).toContain("import type { Plugin } from '@forgeax/engine-plugin';");
    expect(main).toContain("name: 'game-empty'");
    expect(main).toContain('export default gameplay');
    expect(JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8'))).toMatchObject({
      id: 'selected-engine-template',
      name: 'Selected',
    });
    expect(existsSync(resolve(gameDir, 'sessions'))).toBe(false);
    expect(existsSync(resolve(gameDir, '.forgeax/project-dependency-links.json'))).toBe(true);
  });

  test('creates a minimal project without showcase assets or generated scripts', async () => {
    const app = new Hono();
    app.route('/api', createProductApiRouter());
    const response = await app.request('/api/projects', {
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
    const created = readdirSync(gameDir);
    expect(created).toEqual(expect.arrayContaining([
      'AGENTS.md', 'FORGE.md', 'forge.json', 'items.json', 'main.ts', 'package.json', 'tests',
    ]));
    expect(created).not.toContain('assets');
    expect(existsSync(resolve(gameDir, '.forgeax/project-dependency-links.json'))).toBe(true);
    expect(existsSync(resolve(gameDir, 'assets'))).toBe(false);
    expect(existsSync(resolve(gameDir, 'tests/baseline.test.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(gameDir, 'package.json'), 'utf8'))).toMatchObject({
      scripts: { test: 'node --test tests/baseline.test.mjs' },
    });
    expect(readFileSync(resolve(gameDir, 'main.ts'), 'utf8')).not.toContain('generate-assets');
  });
});
