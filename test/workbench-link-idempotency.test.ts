/** Regression: opening the already-mounted game directory is idempotent.
 *
 * The file browser returns the canonical game path, which for an internal game
 * is already `.forgeax/games/<slug>`. Re-posting that path must activate the
 * existing mount instead of reporting a slug collision.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { initPathManager, resetPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { knownGamesFile } from '@forgeax/platform-io';
import { createWorkbenchRouter } from '../src/game/workbench';

let instanceRoot: string;
let previousProjectRoot: string | undefined;
let previousKnownGames: string | undefined;
let app: Hono;

beforeEach(() => {
  instanceRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-link-idempotent-'));
  previousProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = instanceRoot;
  const registry = knownGamesFile();
  previousKnownGames = existsSync(registry) ? readFileSync(registry, 'utf-8') : undefined;
  resetPathManager();
  initPathManager({ projectRoot: instanceRoot });
  app = new Hono();
  app.route('/api/workbench', createWorkbenchRouter());
});

afterEach(() => {
  resetPathManager();
  if (previousProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = previousProjectRoot;
  const registry = knownGamesFile();
  if (previousKnownGames === undefined) rmSync(registry, { force: true });
  else writeFileSync(registry, previousKnownGames, 'utf-8');
  rmSync(instanceRoot, { recursive: true, force: true });
});

describe('POST /api/workbench/games/link', () => {
  test('re-opening the mounted game activates it instead of returning a collision', async () => {
    const gameDir = resolve(instanceRoot, '.forgeax', 'games', 'pong');
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(resolve(gameDir, 'forge.json'), JSON.stringify({ id: 'pong', name: 'Pong' }), 'utf-8');

    const response = await app.request('/api/workbench/games/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: gameDir }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slug: 'pong', alreadyMounted: true });
  });
});
