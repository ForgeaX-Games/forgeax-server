// Most-recently-touched .forgeax/games/<slug>/ dir under the project root.
// Used by:
//   - api/workbench.ts to report `activeSlug` in /games + /agents responses
//   - cli-providers/providers/claude-code.ts to scope ambiguous user edits
//     ("把背景改成蓝色") onto a specific game directory
//
// Single source so the two consumers cannot drift. Hidden (.foo) and
// underscore (_template) entries are filtered to keep scaffolds + caches
// from masking real games.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Most-recently-modified game folder under `<root>/.forgeax/games/`.
 *
 * Filters out hidden (`.foo`) and underscore-prefixed (`_template`) entries
 * so scaffold dirs + system caches never mask a real game. Returns
 * `undefined` when the games dir is missing, empty, or has only
 * filtered entries.
 *
 * Locked by 5-case test fixture (test/active-slug.test.ts, cc-game/12).
 *
 * @param root - studio/instance project root (typically `defaultProjectRoot()`)
 */
export function detectActiveSlug(root: string): string | undefined {
  const gamesDir = resolve(root, '.forgeax/games');
  if (!existsSync(gamesDir)) return undefined;
  try {
    let best: { slug: string; mtime: number } | undefined;
    for (const e of readdirSync(gamesDir)) {
      if (e.startsWith('.') || e.startsWith('_')) continue;
      const st = statSync(resolve(gamesDir, e));
      if (!st.isDirectory()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { slug: e, mtime: st.mtimeMs };
    }
    return best?.slug;
  } catch {
    return undefined;
  }
}

/**
 * All game slugs under `<root>/.forgeax/games/`, sorted most-recently-modified
 * first. Same filtering as {@link detectActiveSlug} (skips `.`/`_` entries).
 * Read-only; used to build helpful "available games" error messages when an
 * explicit slug is required but missing.
 */
export function listGameSlugs(root: string): string[] {
  const gamesDir = resolve(root, '.forgeax/games');
  if (!existsSync(gamesDir)) return [];
  try {
    const found: { slug: string; mtime: number }[] = [];
    for (const e of readdirSync(gamesDir)) {
      if (e.startsWith('.') || e.startsWith('_')) continue;
      const st = statSync(resolve(gamesDir, e));
      if (!st.isDirectory()) continue;
      found.push({ slug: e, mtime: st.mtimeMs });
    }
    return found.sort((a, b) => b.mtime - a.mtime).map((g) => g.slug);
  } catch {
    return [];
  }
}
