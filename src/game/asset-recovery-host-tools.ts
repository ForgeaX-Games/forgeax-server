import type { HostToolRunCtx, HostToolSpec } from '@forgeax/orchestrator/seams';
import type { RuntimeScopeClient, RuntimeScopeState } from './runtime-scope-client';

export interface AssetRecoveryHostDeps {
  readonly runtime: Pick<RuntimeScopeClient, 'snapshot' | 'recoverAsset'>;
  /** Resolve only the session's currently selected project; never accept a caller filesystem root. */
  readonly resolveGame: (ctx: HostToolRunCtx) => { gameId: string; gameDir: string } | undefined;
  readonly publish: (ctx: HostToolRunCtx, runtime: RuntimeScopeState) => void;
  readonly invalidate: (ctx: HostToolRunCtx) => void;
}

export function assetRecoveryHostTools(deps?: AssetRecoveryHostDeps): HostToolSpec[] {
  if (!deps) return [];
  return [{
    name: 'game_asset_recovery',
    description: 'Inspect the current game runtime and its structured source-scan diagnostics even when the Editor cannot open. Rebuild regenerates metadata for exactly one existing source through the official asset producer, then rebinds and validates the runtime. Specify the session game and its project-relative sourcePath. Missing sources must be restored before rebuilding. Other invalid assets can still prevent binding; metadataRebuilt is not proof of playable output. Use normal Editor import, scene editing and Play after recovery succeeds.',
    inputSchema: {
      type: 'object', properties: {
        action: { enum: ['inspect', 'rebuild'] },
        game: { type: 'string', minLength: 1 },
        sourcePath: { type: 'string', minLength: 1, maxLength: 4096 },
      }, required: ['action', 'game'], additionalProperties: false,
    },
    run: async (args, ctx) => {
      if (!['inspect', 'rebuild'].includes(String(args.action)) || args.game !== ctx.game) {
        return { ok: false, error: { code: 'asset-recovery-invalid-request', hint: 'Select inspect or rebuild for the session game.' } };
      }
      const game = deps.resolveGame(ctx);
      if (!game || game.gameId !== args.game) {
        return { ok: false, error: { code: 'asset-recovery-game-changed', hint: 'The session game must still be selected.' } };
      }
      if (args.action === 'inspect') return { ok: true, game: game.gameId, runtime: deps.runtime.snapshot() };
      if (typeof args.sourcePath !== 'string' || !args.sourcePath.trim() || args.sourcePath.length > 4096) {
        return { ok: false, error: { code: 'asset-recovery-source-required', hint: 'Choose one project-relative sourcePath from the diagnostic.' } };
      }
      const isCurrent = () => {
        const current = deps.resolveGame(ctx);
        return current?.gameId === game.gameId && current.gameDir === game.gameDir;
      };
      deps.invalidate(ctx);
      const result = await deps.runtime.recoverAsset(game.gameId, game.gameDir, args.sourcePath, isCurrent);
      // Host failure adapters serialize only `error`. Keep partial-write facts
      // inside that envelope so a failed scan cannot hide completed metadata work.
      const failure = (diagnostic: unknown) => ({
        ...(diagnostic && typeof diagnostic === 'object' ? diagnostic : {}),
        game: game.gameId,
        sourcePath: args.sourcePath,
        metadataRebuilt: result.metadataRebuilt ?? null,
        runtime: result.runtime,
        diagnostic: result.diagnostic ?? null,
      });
      if (!isCurrent()) return { ...result, ok: false, game: game.gameId, sourcePath: args.sourcePath,
        error: failure({ code: 'asset-recovery-game-changed', hint: 'The selected game changed during recovery; inspect the current runtime before continuing.' }) };
      deps.publish(ctx, result.runtime);
      return { ...result, game: game.gameId, sourcePath: args.sourcePath,
        ...(!result.ok ? { error: failure(result.diagnostic ?? { code: 'asset-recovery-failed', hint: result.runtime.error }) } : {}) };
    },
  }];
}
