import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { HostToolSpec, HostToolRunCtx } from '@forgeax/orchestrator/seams';
import { searchLibrarySources } from './asset-library/host';
import type { EditorTransportHostToolsDeps } from './editor-transport-host-tools';

function gameRoot(ctx: HostToolRunCtx): string {
  if (!ctx.game || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ctx.game)) throw new Error('asset_library_game_required');
  for (const base of ['.forgeax/games', 'games']) {
    const parent = resolve(ctx.projectRoot, base);
    const candidate = resolve(parent, ctx.game);
    if (!existsSync(resolve(candidate, 'forge.json'))) continue;
    const canonical = realpathSync(candidate);
    const rel = relative(realpathSync(parent), canonical);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('asset_library_game_escape');
    return canonical;
  }
  throw new Error('asset_library_game_missing');
}

export interface AssetLibraryHostDeps extends EditorTransportHostToolsDeps {
  search?: typeof searchLibrarySources;
}

export function assetLibraryHostTools(deps: AssetLibraryHostDeps = {}): HostToolSpec[] {
  return [
    {
      name: 'search_game_assets',
      description: 'Search the official reusable 3D asset library for this session game. EA is the default; AW can be explicitly selected. Give 1-8 concrete queries. Downloads and validates one matched source per query, then returns receipt and validated source paths for the existing editor.importAsset operation. Does not change the Engine or create scene objects. Requires the official library credential; never substitute generation on an access failure.',
      inputSchema: {
        type: 'object', required: ['queries'], additionalProperties: false,
        properties: { queries: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 } }, library: { type: 'string', enum: ['ea', 'aw'], default: 'ea' } },
      },
      async run(args, ctx) {
        try {
          if (args.library !== undefined && args.library !== 'ea' && args.library !== 'aw') throw new Error('asset_library_invalid');
          const result = await (deps.search ?? searchLibrarySources)({
            projectRoot: gameRoot(ctx), queries: args.queries as string[], library: args.library as 'ea' | 'aw' | undefined,
            ...(process.env.FORGEAX_RESOURCE_ROOT ? {
              assetsRoot: resolve(process.env.FORGEAX_RESOURCE_ROOT, 'product/asset-library'),
            } : {}),
          });
          return { ok: true, execution: result.execution, library: result.library, imported: false, results: result.result.results.map(item => item.status === 'ok'
            ? { status: item.status, assetId: item.providerAssetId, name: item.assetName, query: item.query, sha256: item.sha256, bytes: item.bytes, sourceFiles: item.manifest.filter(file => file.role !== 'metadata').map(file => ({ path: resolve(result.sourceRoot, file.path), role: file.role, sha256: file.sha256, bytes: file.bytes })), primaryModel: resolve(result.sourceRoot, item.primaryModel) }
            : item) };
        } catch (error) { return failure(error); }
      },
    },
  ];
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'asset_library_failed';
  return { ok: false, error: { code: message.split(':', 1)[0], hint: message.slice(0, 256) } };
}
