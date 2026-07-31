import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNpcSettingsRouter, parseNpcBrainSettings } from '../src/game/npc-settings';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'fx-npc-settings-'));
  roots.push(path);
  return path;
}

describe('NPC Brain settings API', () => {
  test('reads effective defaults and persists model and budget atomically', async () => {
    const projectRoot = root();
    const app = createNpcSettingsRouter({ getProjectRoot: () => projectRoot });

    const initial = await app.request('/');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      config: {},
      effective: { source: 'default', maxTokens: 500, timeoutMs: 12_000 },
    });

    const saved = await app.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'npc-fast',
        fallback: ['npc-safe'],
        budget: { maxCallsPerMinute: 20, maxTokensPerMinute: 8000, maxConcurrent: 2 },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      effective: { model: 'npc-fast', fallback: ['npc-safe'], source: 'global' },
    });
    expect(JSON.parse(readFileSync(join(projectRoot, '.forgeax', 'npc-brain.json'), 'utf8'))).toEqual({
      model: 'npc-fast',
      fallback: ['npc-safe'],
      budget: { maxCallsPerMinute: 20, maxTokensPerMinute: 8000, maxConcurrent: 2 },
    });
  });

  test('preserves unknown config fields and follows the live project root', async () => {
    const first = root();
    const second = root();
    mkdirSync(join(second, '.forgeax'), { recursive: true });
    writeFileSync(join(second, '.forgeax', 'npc-brain.json'), JSON.stringify({ audit: true, model: 'old' }));
    let active = first;
    const app = createNpcSettingsRouter({ getProjectRoot: () => active });
    active = second;

    const saved = await app.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'new' }),
    });
    expect(saved.status).toBe(200);
    expect(existsSync(join(first, '.forgeax', 'npc-brain.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(second, '.forgeax', 'npc-brain.json'), 'utf8'))).toEqual({
      audit: true,
      model: 'new',
    });
  });

  test('rejects invalid and unsupported budgets', async () => {
    expect(() => parseNpcBrainSettings({ budget: { maxConcurrent: -1 } })).toThrow('non-negative integer');
    expect(() => parseNpcBrainSettings({ budget: { maxCostUsd: 1 } })).toThrow('unsupported');
    const app = createNpcSettingsRouter({ getProjectRoot: root });
    const response = await app.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fallback: 'nope' }),
    });
    expect(response.status).toBe(400);
  });
});
