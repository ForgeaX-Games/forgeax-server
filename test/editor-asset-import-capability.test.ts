import { describe, expect, test } from 'bun:test';
import {
  createEditorAssetImportProvider,
  EDITOR_ASSET_IMPORT_CAPABILITY,
  EDITOR_ASSET_IMPORT_CAPABILITY_VERSION,
} from '../src/game/editor-asset-import-capability';
import type { ExtensionCapabilityInvocationContext } from '@forgeax/types';

const context: ExtensionCapabilityInvocationContext = {
  caller: { kind: 'extension', agentId: 'lowpoly-ui', sessionId: 'studio-session' },
  toolId: 'lowpoly:import-glb',
  env: {},
  cwd: '/extensions/3d-lowpoly',
  projectRoot: '/workspace',
  game: 'demo-game',
};

describe('Editor asset import capability', () => {
  test('forwards a game-scoped typed import request to the visible Editor carrier', async () => {
    const requests: unknown[] = [];
    const provider = createEditorAssetImportProvider(async (request) => {
      requests.push(request);
      return { result: { ok: true, requestId: 'import-1' } };
    });

    await expect(provider.invoke({
      base64: 'Z2xURg==',
      destPath: 'assets/3d/robot.glb',
      sourceName: 'robot.glb',
      requestId: 'import-1',
    }, { requestId: 'import-1' }, context)).resolves.toEqual({
      ok: true,
      result: { ok: true, requestId: 'import-1' },
    });
    expect(provider.capabilityId).toBe(EDITOR_ASSET_IMPORT_CAPABILITY);
    expect(provider.version).toBe(EDITOR_ASSET_IMPORT_CAPABILITY_VERSION);
    expect(requests).toEqual([expect.objectContaining({
      scope: 'game:demo-game',
      method: 'asset.importSource',
      timeoutMs: 300_000,
      params: expect.objectContaining({
        actor: { id: 'lowpoly-ui', kind: 'human' },
        sessionId: 'studio-session',
        permission: 'execute',
      }),
    })]);
  });

  test('fails closed when the extension call has no game scope', async () => {
    const provider = createEditorAssetImportProvider(async () => {
      throw new Error('must not dispatch');
    });
    const result = await provider.invoke({
      base64: 'Z2xURg==',
      destPath: 'assets/3d/robot.glb',
      sourceName: 'robot.glb',
      requestId: 'import-1',
    }, {}, { ...context, game: undefined });
    expect(result).toMatchObject({ ok: false, error: { code: 'editor-asset-import-game-missing' } });
  });
});
