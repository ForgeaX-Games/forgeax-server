import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KinoApiError } from './kino-api';

export const VIDEO_ASSET_GAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export type ProjectRootResolver = () => string;

function assertValidSlug(slug: string): void {
  if (!VIDEO_ASSET_GAME_SLUG_RE.test(slug)) {
    throw new KinoApiError(`Invalid game_id: ${slug}`, 400, 'invalid_game_id');
  }
}

function assertExistingGameDirectory(gameDir: string, slug: string): void {
  try {
    const stat = statSync(gameDir);
    if (!stat.isDirectory()) {
      throw new KinoApiError(`Game not found: ${slug}`, 404, 'game_not_found');
    }
  } catch (error) {
    if (error instanceof KinoApiError) {
      throw error;
    }
    throw new KinoApiError(`Game not found: ${slug}`, 404, 'game_not_found');
  }
}

export function resolveGameDir(slug: string, getProjectRoot: ProjectRootResolver): string {
  assertValidSlug(slug);
  const gameDir = resolve(getProjectRoot(), '.forgeax', 'games', slug);
  assertExistingGameDirectory(gameDir, slug);
  return gameDir;
}

export function resolveVideoAssetsDir(
  slug: string,
  getProjectRoot: ProjectRootResolver,
): string {
  const gameDir = resolveGameDir(slug, getProjectRoot);
  return join(gameDir, 'game-video', 'assets');
}
