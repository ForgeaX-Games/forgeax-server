/**
 * Engine-root detection for the web/standalone export pipeline.
 *
 * Static game builds are owned by the Engine DevKit.  The server only chooses
 * an installed Engine workspace and invokes its public `forgeax build` CLI;
 * it must not reach into the retired Studio/Build standalone script.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EngineRootCandidate {
  /** Absolute path to the engine root. */
  path: string;
  /** Short human label for the UI. */
  label: string;
  /** Whether this root exposes the Engine DevKit build contract. */
  valid: boolean;
  /** Whether this is the auto-detected default. */
  recommended: boolean;
}

/** Locations (relative to the Studio install root) that may host the engine. */
const CANDIDATE_RELS: Array<{ rel: string; label: string }> = [
  { rel: 'packages/editor/packages/engine', label: 'engine (editor)' },
  { rel: 'packages/engine', label: 'engine (standalone)' },
  { rel: 'resources/engine', label: 'engine (desktop bundle)' },
];

/** Source-workspace and packaged-runtime locations of the Engine build CLI. */
export const ENGINE_DEVKIT_CLI_RELATIVE = join('packages', 'devkit', 'dist', 'cli.mjs');
export const PACKAGED_ENGINE_DEVKIT_CLI_RELATIVE = join(
  'node_modules',
  '@forgeax',
  'engine-devkit',
  'dist',
  'cli.mjs',
);

/** Resolve the public DevKit CLI for a selected Engine workspace. */
export function engineDevkitCliPath(engineRoot: string): string {
  const sourceCli = join(engineRoot, ENGINE_DEVKIT_CLI_RELATIVE);
  if (existsSync(sourceCli)) return sourceCli;
  const packagedCli = join(engineRoot, PACKAGED_ENGINE_DEVKIT_CLI_RELATIVE);
  if (existsSync(packagedCli)) return packagedCli;
  return sourceCli;
}

/**
 * A candidate is usable only when the packaged DevKit CLI and its package
 * manifest are present.  Vite, pack cooking, shader compilation, and the
 * browser runtime are implementation details of that Engine-owned CLI.
 */
function isValidEngineRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'package.json')) &&
    existsSync(engineDevkitCliPath(dir))
  );
}

/**
 * Scan known engine-root locations under `studioRoot`. The first valid
 * candidate is marked `recommended`.
 */
export function detectEngineRoots(studioRoot: string): EngineRootCandidate[] {
  const out: EngineRootCandidate[] = [];
  let recommendedAssigned = false;

  for (const { rel, label } of CANDIDATE_RELS) {
    const path = join(studioRoot, rel);
    if (!existsSync(path)) continue;
    const valid = isValidEngineRoot(path);
    const recommended = valid && !recommendedAssigned;
    if (recommended) recommendedAssigned = true;
    out.push({ path, label, valid, recommended });
  }

  return out;
}

/** Convenience: the recommended engine root path, or undefined when none valid. */
export function recommendedEngineRoot(studioRoot: string): string | undefined {
  return detectEngineRoots(studioRoot).find((r) => r.recommended)?.path;
}
