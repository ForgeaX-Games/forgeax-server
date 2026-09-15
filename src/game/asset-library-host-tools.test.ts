import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetLibraryHostTools } from './asset-library-host-tools';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'library-host-')); roots.push(root);
  const game = join(root, '.forgeax/games/kart'); mkdirSync(game, { recursive: true });
  writeFileSync(join(game, 'forge.json'), '{}');
  return { root, game, ctx: { projectRoot: root, game: 'kart', agentId: 'forge' } };
}
test('default tools bind search to the session game and preserve explicit AW', async () => {
  const { ctx, game } = fixture();
  const calls: unknown[] = [];
  const tool = assetLibraryHostTools({ search: async options => {
    calls.push(options);
    return { schemaVersion: 'forgeax.host-library-sources/1.0.0', execution: 'receipt', library: options.library ?? 'ea', providerCommit: 'test', sourceRoot: game, result: { schemaVersion: 'forgeax.asset3d-search-result/1.0.0', total: 1, succeeded: 0, failed: 1, results: [] } };
  } })[0]!;
  expect(await tool.run!({ queries: ['kart'] }, ctx)).toMatchObject({ ok: true, library: 'ea', imported: false });
  await tool.run!({ queries: ['kart'], library: 'aw' }, ctx);
  expect(calls).toEqual([{ projectRoot: realpathSync(game), queries: ['kart'], library: undefined }, { projectRoot: realpathSync(game), queries: ['kart'], library: 'aw' }]);
});
test('missing or escaping game is rejected before catalog access', async () => {
  const { ctx } = fixture(); let called = false;
  const tool = assetLibraryHostTools({ search: async () => { called = true; throw new Error('unexpected'); } })[0]!;
  expect(await tool.run!({ queries: ['kart'] }, { ...ctx, game: '../other' })).toMatchObject({ ok: false, error: { code: 'asset_library_game_required' } });
  expect(called).toBe(false);
});
