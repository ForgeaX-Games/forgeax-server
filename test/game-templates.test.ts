import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { createGameTemplatesRouter, listGameTemplates } from '../src/game/game-templates';
import { createWorkbenchRouter } from '../src/game/workbench';

let projectRoot: string;
let previousProjectRoot: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-game-templates-'));
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

describe('GET /api/game-templates', () => {
  test('lists valid projects from the editor engine template catalog', async () => {
    const app = new Hono();
    app.route('/api', createGameTemplatesRouter());

    const response = await app.request('/api/game-templates');
    expect(response.status).toBe(200);

    const body = await response.json() as { templates: Array<{ slug: string; name: string }> };
    expect(body.templates).toEqual(await listGameTemplates());
    expect(body.templates.map((template) => template.slug)).toEqual(
      [...body.templates.map((template) => template.slug)].sort(),
    );
    expect(body.templates).toEqual(expect.arrayContaining([
      { slug: 'game-default', name: 'Default' },
      { slug: 'game-empty', name: 'Empty' },
    ]));
    expect(body.templates.every((template) => template.name.trim().length > 0)).toBe(true);
  });

  test('creates a new game from a selected engine template', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter({ cloneTemplateAssets: async () => {} }));

    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'empty-start', name: 'Empty Start', template: 'game-empty' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/empty-start');
    const manifest = JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8')) as {
      id?: string;
      name?: string;
    };
    expect(manifest).toMatchObject({ id: 'empty-start', name: 'Empty Start' });
    expect(existsSync(resolve(gameDir, 'main.ts'))).toBe(true);
  });
});
