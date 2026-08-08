import { resolveForgeaxGameProjection } from '@forgeax/platform-io';
import { isGameSlug } from './game-slug';

export interface ResolvedInstanceGame {
  gameId: string;
  gameDir: string;
}

/**
 * Resolve one direct child game of this Studio instance.
 *
 * The lexical slug guard rejects traversal before path resolution. A game may
 * be a real direct child of `.forgeax/games` or a launcher-managed projection
 * of one direct child from `packages/games`. Everything else—including nested
 * targets, the roots themselves, dangling links, and arbitrary external
 * directories—is rejected. A link to another direct child remains valid.
 */
export function resolveInstanceGame(
  root: string,
  slug: unknown,
): ResolvedInstanceGame | undefined {
  if (!isGameSlug(slug)) return undefined;

  const projection = resolveForgeaxGameProjection(root, slug);
  return projection
    ? { gameId: slug, gameDir: projection.gameRoot }
    : undefined;
}
