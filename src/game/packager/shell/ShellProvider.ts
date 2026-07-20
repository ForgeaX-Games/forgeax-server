/**
 * ShellProvider — builds (or retrieves from cache) the universal game launcher
 * binary via `bun build --compile`, per host/target platform.
 *
 * No Rust required. The launcher source lives at
 * `packages/build/player-launcher/player-launcher.ts` and is cross-platform at
 * runtime (opens Edge/Chrome --app on Windows, the default browser on macOS).
 *
 * Cache location: `~/.forgeax/cache/player-shell/forgeax-player-v<V>-<plat>[.exe]`
 *   + `shell-meta-<plat>.json` (version, builtAt).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assetRoot } from '@forgeax/platform-io';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

const SHELL_VERSION = '5';
const META_PREFIX = 'shell-meta';

export type ShellPlatform = 'windows' | 'macos';

interface ShellVariant {
  /** bun --compile target triple; omitted → host target (mac→mac). */
  target?: string;
  extraFlags: string[];
  exeName: string;
}

function variantFor(platform: ShellPlatform): ShellVariant {
  if (platform === 'macos') {
    // Build for the host arch — the mac export is primarily for playtesting on
    // this machine. bun with no --target compiles for the current host.
    return { extraFlags: [], exeName: `forgeax-player-v${SHELL_VERSION}-macos` };
  }
  return {
    target: 'bun-windows-x64',
    extraFlags: ['--windows-hide-console'],
    exeName: `forgeax-player-v${SHELL_VERSION}.exe`,
  };
}

interface ShellMeta {
  version: string;
  builtAt: number;
}

export interface ShellResult {
  ok: boolean;
  exePath?: string;
  cached: boolean;
  error?: string;
}

const buildPromises = new Map<ShellPlatform, Promise<ShellResult>>();

export async function getOrBuildShell(
  cacheDir: string,
  platform: ShellPlatform = 'windows',
  onProgress?: (phase: string, line?: string) => void,
  forceRebuild?: boolean,
): Promise<ShellResult> {
  // Concurrency lock per platform: if a build is already in flight, await it
  const inFlight = buildPromises.get(platform);
  if (inFlight) return inFlight;

  const variant = variantFor(platform);
  const shellDir = join(cacheDir, 'player-shell');
  const exePath = join(shellDir, variant.exeName);
  const metaPath = join(shellDir, `${META_PREFIX}-${platform}.json`);

  if (forceRebuild) {
    onProgress?.('shell-build', 'forceRebuild: clearing shell cache');
    rmSync(exePath, { force: true });
    rmSync(metaPath, { force: true });
  }

  // Cache hit
  if (existsSync(exePath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ShellMeta;
      if (meta.version === SHELL_VERSION) {
        onProgress?.('shell-build', `cache hit: ${variant.exeName}`);
        return { ok: true, exePath, cached: true };
      }
    } catch { /* stale meta, rebuild */ }
  }

  // Cache miss — compile
  const promise = (async (): Promise<ShellResult> => {
    try {
      onProgress?.('shell-build', 'compiling launcher with bun --compile …');
      mkdirSync(shellDir, { recursive: true });

      const root = studioRoot();
      const launcherSrc = resolve(root, 'packages/build/player-launcher/player-launcher.ts');
      if (!existsSync(launcherSrc)) {
        return { ok: false, cached: false, error: `launcher source not found: ${launcherSrc}` };
      }

      const bunBin = process.execPath || 'bun';
      const proc = Bun.spawn({
        cmd: [
          bunBin, 'build', launcherSrc,
          '--compile',
          ...(variant.target ? [`--target=${variant.target}`] : []),
          ...variant.extraFlags,
          `--outfile=${exePath}`,
        ],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (code !== 0) {
        onProgress?.('shell-build', `compile failed (exit ${code})`);
        return {
          ok: false,
          cached: false,
          error: 'bun --compile failed',
          ...(stderr || stdout ? { error: (stderr || stdout).split('\n').slice(-20).join('\n') } : {}),
        };
      }

      // Host-target compiles (macOS) emit a Unix executable — make sure it is
      // marked runnable regardless of umask.
      if (!variant.target) {
        try { chmodSync(exePath, 0o755); } catch { /* best effort */ }
      }

      const meta: ShellMeta = { version: SHELL_VERSION, builtAt: Date.now() };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      onProgress?.('shell-build', `compiled → ${variant.exeName}`);

      return { ok: true, exePath, cached: false };
    } catch (e) {
      return { ok: false, cached: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      buildPromises.delete(platform);
    }
  })();

  buildPromises.set(platform, promise);
  return promise;
}
