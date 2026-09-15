import { expect, test } from 'bun:test';
import type { HostToolRunCtx } from '@forgeax/orchestrator/seams';
import { assetRecoveryHostTools, type AssetRecoveryHostDeps } from './asset-recovery-host-tools';

const ctx = { game: 'kart', projectRoot: '/project', sid: 'session', agentId: 'forge' } as HostToolRunCtx;
function fixture() {
  let selected = true;
  const calls: string[] = [];
  const deps: AssetRecoveryHostDeps = {
    runtime: {
      snapshot: () => ({ status: 'unavailable', diagnostic: { code: 'pack-orphan-meta' } }),
      recoverAsset: async (gameId, gameDir, sourcePath) => {
        calls.push(`${gameId}:${gameDir}:${sourcePath}`);
        return { ok: false, metadataRebuilt: true, runtime: { status: 'unavailable' }, diagnostic: { code: 'scan-failed' } };
      },
    },
    resolveGame: () => selected ? { gameId: 'kart', gameDir: '/project/.forgeax/games/kart' } : undefined,
    publish: () => { calls.push('publish'); }, invalidate: () => { calls.push('invalidate'); },
  };
  return { deps, calls, tool: assetRecoveryHostTools(deps)[0]!, switchGame: () => { selected = false; } };
}

test('normal host discovery provides diagnostics without requiring an Editor carrier or writing', async () => {
  const f = fixture();
  expect(await f.tool.run!({ action: 'inspect', game: 'kart' }, ctx)).toMatchObject({ ok: true, runtime: { diagnostic: { code: 'pack-orphan-meta' } } });
  expect(f.calls).toEqual([]);
});

test('recovery is explicit, project-bound and publishes a failed scan without claiming playable success', async () => {
  const f = fixture();
  expect(await f.tool.run!({ action: 'rebuild', game: 'kart' }, ctx)).toMatchObject({ ok: false });
  expect(await f.tool.run!({ action: 'rebuild', game: 'other', sourcePath: 'assets/kart.glb' }, ctx)).toMatchObject({ ok: false });
  expect(f.calls).toEqual([]);
  expect(await f.tool.run!({ action: 'rebuild', game: 'kart', sourcePath: 'assets/kart.glb' }, ctx)).toMatchObject({ ok: false, metadataRebuilt: true, error: { code: 'scan-failed', metadataRebuilt: true, game: 'kart', sourcePath: 'assets/kart.glb', runtime: { status: 'unavailable' }, diagnostic: { code: 'scan-failed' } } });
  expect(f.calls).toEqual(['invalidate', 'kart:/project/.forgeax/games/kart:assets/kart.glb', 'publish']);
});

test('selection changes do not publish recovered state into a different active game', async () => {
  const f = fixture();
  f.deps.runtime.recoverAsset = async () => {
    f.switchGame();
    return { ok: true, metadataRebuilt: true, runtime: { status: 'ready' } };
  };
  expect(await f.tool.run!({ action: 'rebuild', game: 'kart', sourcePath: 'assets/kart.glb' }, ctx)).toMatchObject({ ok: false, error: { code: 'asset-recovery-game-changed', metadataRebuilt: true, runtime: { status: 'ready' }, game: 'kart', sourcePath: 'assets/kart.glb' } });
  expect(f.calls).toEqual(['invalidate']);
});

for (const metadataRebuilt of [false, undefined] as const) {
  test(`failed recovery preserves ${metadataRebuilt} write status in its error envelope`, async () => {
    const f = fixture();
    f.deps.runtime.recoverAsset = async () => ({ ok: false, metadataRebuilt, runtime: { status: 'unavailable' } });
    const result = await f.tool.run!({ action: 'rebuild', game: 'kart', sourcePath: 'assets/kart.glb' }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-recovery-failed', metadataRebuilt: metadataRebuilt ?? null, runtime: { status: 'unavailable' }, diagnostic: null } });
  });
}

test('successful recovery remains a success without an error envelope', async () => {
  const f = fixture();
  f.deps.runtime.recoverAsset = async () => ({ ok: true, metadataRebuilt: true, runtime: { status: 'ready' } });
  const result = await f.tool.run!({ action: 'rebuild', game: 'kart', sourcePath: 'assets/kart.glb' }, ctx);
  expect(result).toMatchObject({ ok: true, metadataRebuilt: true, runtime: { status: 'ready' } });
  expect(result).not.toHaveProperty('error');
});
