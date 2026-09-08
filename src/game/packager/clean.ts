/**
 * Clean local packaging environment.
 *
 * Wipes the on-disk artefacts that packaging installs/caches outside the
 * user's game source, so the next packaging run rebuilds them from scratch:
 *
 *   1. Isolated Rust toolchain  — `~/.forgeax/toolchains` (rustup + cargo +
 *      the prebuilt wasm-pack); only ever populated by "Rebuild Engine Core".
 *   2. Launcher shell cache     — `~/.forgeax/cache/player-shell` (the
 *      bun --compile'd Windows launcher exe + meta).
 * It deliberately does NOT touch packaging *products* (`.forgeax/exports/*`)
 * nor the history ledger (`~/.forgeax/exports-history.json`) — those are
 * deliverables / user data, not rebuildable environment.
 */

import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { friendlyPath } from '@forgeax/platform-io';

export interface CleanedTarget {
  /** User-friendly path of the target. */
  path: string;
  existed: boolean;
  removed: boolean;
  /** Approximate freed size in bytes (best-effort, 0 when unknown). */
  bytes: number;
  error?: string;
}

export interface CleanReport {
  ok: boolean;
  targets: CleanedTarget[];
  totalBytes: number;
}

/** Best-effort recursive byte size; never throws, caps depth defensively. */
function dirSize(path: string, depth = 0): number {
  if (depth > 64) return 0;
  let total = 0;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    for (const entry of readdirSync(path)) {
      total += dirSize(join(path, entry), depth + 1);
    }
  } catch {
    /* unreadable entry — skip */
  }
  return total;
}

/** Collect the absolute paths that constitute the packaging environment. */
function targetPaths(): string[] {
  const base = join(homedir(), '.forgeax');
  const paths = new Set<string>([
    join(base, 'toolchains'),
    join(base, 'cache', 'player-shell'),
  ]);
  return [...paths];
}

/**
 * Delete every packaging-environment path. Best-effort and idempotent:
 * non-existent targets are reported (`existed:false`) rather than erroring.
 */
export function cleanPackagingEnv(): CleanReport {
  const targets: CleanedTarget[] = [];
  let totalBytes = 0;

  for (const abs of targetPaths()) {
    const friendly = friendlyPath(abs);
    if (!existsSync(abs)) {
      targets.push({ path: friendly, existed: false, removed: false, bytes: 0 });
      continue;
    }
    const bytes = dirSize(abs);
    try {
      rmSync(abs, { recursive: true, force: true });
      totalBytes += bytes;
      targets.push({ path: friendly, existed: true, removed: true, bytes });
    } catch (e) {
      targets.push({
        path: friendly,
        existed: true,
        removed: false,
        bytes,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: targets.every((t) => !t.existed || t.removed),
    targets,
    totalBytes,
  };
}
