// game-host-hooks.ts — product-shell implementation of the game-host
// version-prepare hook (injected via ProductContext.gameHostBeforeVersion).
//
// Runs server-side right before `git add -A` when a game version is created.
// For wb-game-video games it copies the platform component set into the game
// dir so the components travel with that game's git version — no vite, no
// per-save client work; a plain Node fs copy.
//
// Layering: platform-io game-host stays generic (just invokes the hook); the
// knowledge of "which extension, which source path" lives here in the product
// shell (which already owns extension paths via `mp`).

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mp } from '@forgeax/platform-io';

function copyDirExcludingTests(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === '__tests__') continue;
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyDirExcludingTests(s, d);
    else copyFileSync(s, d);
  }
}

/** wb-game-video component source (dev: extension `src`). */
function wbGameVideoComponentsSrc(): string {
  return mp('wb-game-video', 'src', 'runtime', 'component-host', 'components');
}

type Project = { platform?: unknown } | null | undefined;

/**
 * Version-prepare hook: for wb-game-video games, sync the platform component set
 * into `<gameDir>/components` before the version is committed. No-op for other
 * platforms, or when the source isn't present (packaged/prod dist-only builds —
 * the game version is already固化 there).
 */
export async function gameHostBeforeVersion(args: {
  slug: string;
  gameDir: string;
  project: unknown;
}): Promise<void> {
  const project = args.project as Project;
  if (project?.platform !== 'wb-game-video') return;
  const src = wbGameVideoComponentsSrc();
  if (!existsSync(src)) return; // prod/dist-only: skip (components already固化 in the release)
  const dest = resolve(args.gameDir, 'components');
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  copyDirExcludingTests(src, dest);
}
