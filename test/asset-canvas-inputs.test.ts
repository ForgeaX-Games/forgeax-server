import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetCanvasInputsRouter } from '../src/game/asset-canvas-inputs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('asset canvas input route', () => {
  test('serves only a content-addressed upload from the active project', async () => {
    const root = makeRoot();
    const uploads = join(root, '.forgeax', 'games', 'demo-game', 'asset-canvas', 'uploads');
    mkdirSync(uploads, { recursive: true });
    const fileName = '0123456789abcdef-icon.png';
    writeFileSync(join(uploads, fileName), new Uint8Array([1, 2, 3]));
    const app = createAssetCanvasInputsRouter(() => root);

    const response = await app.request(`/demo-game/${fileName}`);

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('rejects traversal and symlinked upload directories', async () => {
    const root = makeRoot();
    const game = join(root, '.forgeax', 'games', 'demo-game', 'asset-canvas');
    const outside = mkdtempSync(join(tmpdir(), 'asset-canvas-route-outside-'));
    roots.push(outside);
    mkdirSync(game, { recursive: true });
    symlinkSync(outside, join(game, 'uploads'));
    const app = createAssetCanvasInputsRouter(() => root);

    expect((await app.request('/demo-game/../../secret')).status).not.toBe(200);
    expect((await app.request('/demo-game/0123456789abcdef-icon.png')).status).toBe(404);
  });

  test('never serves active HTML or SVG content', async () => {
    const root = makeRoot();
    const uploads = join(root, '.forgeax', 'games', 'demo-game', 'asset-canvas', 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, '0123456789abcdef-payload.html'), '<script>alert(1)</script>');
    writeFileSync(join(uploads, '0123456789abcdef-payload.svg'), '<svg onload="alert(1)"/>');
    const app = createAssetCanvasInputsRouter(() => root);

    expect((await app.request('/demo-game/0123456789abcdef-payload.html')).status)
      .toBe(415);
    expect((await app.request('/demo-game/0123456789abcdef-payload.svg')).status)
      .toBe(415);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'asset-canvas-route-'));
  roots.push(root);
  return root;
}
