import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { createWorkbenchRouter } from '../src/game/workbench';

let projectRoot: string;
let previousProjectRoot: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-create-minimal-'));
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

describe('POST /api/workbench/games minimal default', () => {
  test('creates a capability-light project without showcase assets or generated scripts', async () => {
    const app = new Hono();
    app.route('/api/workbench', createWorkbenchRouter());
    const response = await app.request('/api/workbench/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'clean-start', name: 'Clean Start' }),
    });
    expect(response.status).toBe(200);

    const gameDir = resolve(projectRoot, '.forgeax/games/clean-start');
    const manifest = JSON.parse(readFileSync(resolve(gameDir, 'forge.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'clean-start', name: 'Clean Start', entry: 'main.ts', physics: false,
    });
    expect(manifest).not.toHaveProperty('defaultScene');
    expect(readdirSync(gameDir).sort()).toEqual([
      'AGENTS.md', 'FORGE.md', 'forge.json', 'items.json', 'main.ts', 'package.json',
    ]);
    expect(readFileSync(resolve(gameDir, 'main.ts'), 'utf8')).not.toContain('generate-assets');
  });
});
