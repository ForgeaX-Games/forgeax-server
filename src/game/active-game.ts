// Explicit "active game" binding — the SSOT for "which game is the user
// currently working on" within the Studio instance.
//
// Why this exists (root-fix 2026-05-29): the active game used to be derived
// purely from `detectActiveSlug()` — most-recently-mtime'd .forgeax/games/<slug>/
// dir. That heuristic is fragile: any `touch`, scaffold copy, or stray write
// reorders it, so the agent CLI's working directory + the system-prompt scope
// could silently point at the wrong game. Worse, nothing ever *recorded* the
// user's explicit choice (create a game / pick a game in the switcher), so a
// session's cli stayed glued to whatever game happened to be newest at boot.
//
// This module persists the user's explicit selection at
//   <projectRoot>/.forgeax/active-game.json  → { version: 1, slug }
// `getActiveGame()` returns that slug when it still resolves to a real game
// dir, and only falls back to the mtime heuristic when no explicit binding
// exists (fresh instance / pre-existing installs). Consumers (claude-code
// provider, /api/workbench endpoints, session defaultDir bootstrap) read this
// single function so they cannot drift.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getEventBus } from '@forgeax/orchestrator/events/bus';
import { detectActiveSlug } from './active-slug';
import { isGameSlug } from './game-slug';

export const ACTIVE_GAME_CHANGED_TOPIC = 'workbench.active-game.changed';

export interface ActiveGameSelection {
  activeSlug: string | null;
}

interface ActiveGameStore {
  version: 1;
  slug: string;
}

export function activeGameFile(root: string): string {
  return resolve(root, '.forgeax', 'active-game.json');
}

function gameDirExists(root: string, slug: string): boolean {
  return existsSync(resolve(root, '.forgeax/games', slug));
}

/** Read the explicitly-recorded active game slug, or `undefined` if none. */
function readExplicit(root: string): string | undefined {
  const file = activeGameFile(root);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActiveGameStore>;
    if (parsed.version !== 1) return undefined;
    const slug = typeof parsed.slug === 'string' ? parsed.slug : undefined;
    if (!isGameSlug(slug)) return undefined;
    return slug;
  } catch {
    return undefined;
  }
}

/**
 * The active game slug for the current Studio instance.
 *
 * Resolution order:
 *   1. explicit binding (active-game.json) — IF the slug still points at a
 *      real .forgeax/games/<slug>/ dir (a deleted game shouldn't pin forever);
 *   2. else the legacy most-recent-mtime heuristic (detectActiveSlug);
 *   3. else `undefined` (no games at all).
 *
 * @param root - Studio instance root (typically `defaultProjectRoot()`)
 */
export function getActiveGame(root: string): string | undefined {
  const explicit = readExplicit(root);
  if (explicit && gameDirExists(root, explicit)) return explicit;
  const detected = detectActiveSlug(root);
  if (detected) writeSelection(root, detected);
  return detected;
}

/**
 * Record the explicit active-game choice and publish its derived notification.
 * Invalid or missing games fail at the authority boundary.
 */
export function setActiveGame(root: string, slug: string): ActiveGameSelection {
  if (!isGameSlug(slug)) throw new Error(`invalid game slug: ${slug}`);
  if (!gameDirExists(root, slug)) throw new Error(`game not found: ${slug}`);
  const previous = getActiveGame(root) ?? null;
  writeSelection(root, slug);
  const selection = { activeSlug: slug } as const;
  if (previous !== slug) getEventBus().emit(ACTIVE_GAME_CHANGED_TOPIC, selection);
  return selection;
}

function writeSelection(root: string, slug: string): void {
  const file = activeGameFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const store: ActiveGameStore = { version: 1, slug };
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Drop the explicit binding IFF it currently points at `slug`. Called when a
 * game is deleted so a removed slug doesn't keep `getActiveGame` pinned to a
 * now-missing dir (which would otherwise force the mtime fallback to resolve
 * something — usually fine, but the binding should reflect reality). After this
 * `getActiveGame` re-derives from the remaining games via the mtime heuristic.
 * No-op when the binding is absent or points elsewhere.
 */
export function clearActiveGameIf(root: string, slug: string): ActiveGameSelection {
  if (readExplicit(root) !== slug) return { activeSlug: getActiveGame(root) ?? null };
  try {
    rmSync(activeGameFile(root));
  } catch {
    /* already gone — fine */
  }
  const selection = { activeSlug: getActiveGame(root) ?? null };
  getEventBus().emit(ACTIVE_GAME_CHANGED_TOPIC, selection);
  return selection;
}
