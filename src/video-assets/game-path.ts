import { join } from 'node:path';
import { KinoApiError } from './kino-api';
import { GAME_SLUG_RE } from '../game/game-slug';
import { resolveInstanceGame } from '../game/instance-game';

export const VIDEO_ASSET_GAME_SLUG_RE = GAME_SLUG_RE;
export type ProjectRootResolver = () => string;

function assertValidSlug(slug: string): void {
  if (!VIDEO_ASSET_GAME_SLUG_RE.test(slug)) {
    throw new KinoApiError(`Invalid game_id: ${slug}`, 400, 'invalid_game_id');
  }
}

export function resolveGameDir(slug: string, getProjectRoot: ProjectRootResolver): string {
  assertValidSlug(slug);
  const game = resolveInstanceGame(getProjectRoot(), slug);
  if (!game) {
    throw new KinoApiError(`Game not found: ${slug}`, 404, 'game_not_found');
  }
  return game.gameDir;
}

export function resolveVideoAssetsDir(
  slug: string,
  getProjectRoot: ProjectRootResolver,
): string {
  const gameDir = resolveGameDir(slug, getProjectRoot);
  return join(gameDir, 'assets');
}
