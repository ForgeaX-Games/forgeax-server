/**
 * Web platform packager — produces a self-contained static site.
 *
 * Ordinary games are built exclusively through the Engine-owned DevKit CLI.
 * Reel games remain on the dedicated Build reel pipeline until that product
 * has an equivalent Engine command; they do not use the retired 3D builder.
 *
 * If `rebuildEngine` is true, the Rust→WASM Engine core (wgpu-wasm) is
 * compiled first via the isolated toolchain.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IGamePackager, PackageOptions, PackageResult } from '../IGamePackager';
import { friendlyPath, assetRoot } from '@forgeax/platform-io';
import { buildWasmCore } from '../shell/toolchain';
import {
  detectEngineRoots,
  engineDevkitCliPath,
  PACKAGED_ENGINE_DEVKIT_CLI_RELATIVE,
  recommendedEngineRoot,
} from '../engine-roots';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

function isReelGame(gameDir: string): boolean {
  try {
    const p = join(gameDir, 'reel', 'scenarios.json');
    if (!existsSync(p)) return false;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0;
  } catch {
    return false;
  }
}

/**
 * Serialize export builds per Engine workspace. Two heavy DevKit builds
 * hammering the same Vite/DDC caches (CPU and memory) are wasteful and
 * historically flaky, so queue them one-at-a-time per Engine root. Each task
 * waits for the previous to settle; a rejection is swallowed for the chain so
 * it never leaks into the next waiter.
 */
const exportChains = new Map<string, Promise<unknown>>();

function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = exportChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const link = next.then(() => undefined, () => undefined);
  exportChains.set(key, link);
  void link.then(() => {
    if (exportChains.get(key) === link) exportChains.delete(key);
  });
  return next;
}

interface DevkitEnvelope {
  ok?: unknown;
  error?: {
    code?: unknown;
    expected?: unknown;
    hint?: unknown;
    detail?: unknown;
  };
}

function parseDevkitEnvelope(stdout: string): DevkitEnvelope | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed as DevkitEnvelope : undefined;
  } catch {
    // Keep looking below. A future CLI may write a diagnostic line before the
    // final JSON envelope even in --json mode.
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (parsed !== null && typeof parsed === 'object') return parsed as DevkitEnvelope;
    } catch {
      /* not the envelope */
    }
  }
  return undefined;
}

function tailLines(value: string, max = 40): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-max).join('\n');
}

function formatDevkitFailure(envelope: DevkitEnvelope | undefined, stdout: string, stderr: string): string {
  const error = envelope?.error;
  if (error && typeof error.code === 'string') {
    const detail = error.detail === undefined ? '' : `\n${JSON.stringify(error.detail)}`;
    const hint = typeof error.hint === 'string' ? `: ${error.hint}` : '';
    return `${error.code}${hint}${detail}`;
  }
  return tailLines(stderr || stdout) || 'Engine DevKit exited without a diagnostic';
}

function selectEngineRoot(
  studioRootPath: string,
  requested: string | undefined,
): { ok: true; path: string } | { ok: false; error: string; detail: string } {
  const candidates = detectEngineRoots(studioRootPath);
  if (requested !== undefined) {
    const path = resolve(studioRootPath, requested);
    const known = candidates.find((candidate) => candidate.path === path);
    if (known?.valid) return { ok: true, path };
    // Explicit external Engine checkouts are supported, but only when they
    // expose the same public DevKit contract as a bundled workspace.
    if (existsSync(join(path, 'package.json')) && existsSync(engineDevkitCliPath(path))) {
      return { ok: true, path };
    }
    return {
      ok: false,
      error: 'selected engine root is invalid (missing Engine DevKit CLI)',
      detail: path,
    };
  }
  const path = recommendedEngineRoot(studioRootPath);
  if (path !== undefined) return { ok: true, path };
  return {
    ok: false,
    error: 'no usable Engine workspace found',
    detail: `candidates: ${JSON.stringify(candidates)}`,
  };
}

export class WebPackager implements IGamePackager {
  readonly platform = 'web' as const;

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, outDir, rebuildEngine, onProgress } = opts;
    const reel = isReelGame(gameDir);
    const root = studioRoot();
    const selectedEngine = reel && !rebuildEngine
      ? undefined
      : selectEngineRoot(root, opts.engineRoot);

    if (selectedEngine !== undefined && !selectedEngine.ok) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: selectedEngine.error,
        detail: selectedEngine.detail,
      };
    }

    // Optional: rebuild engine WASM core
    if (rebuildEngine) {
      onProgress?.('engine-rebuild', 'rebuilding wgpu-wasm engine core …');
      const wasmResult = await buildWasmCore(onProgress, selectedEngine?.path);
      if (!wasmResult.ok) {
        return {
          ok: false,
          slug,
          platform: 'web',
          rebuiltEngine: true,
          error: 'engine WASM core rebuild failed',
          detail: wasmResult.error,
        };
      }
    }

    if (reel) {
      return this.buildReel({ slug, outDir, root, onProgress });
    }
    // Non-reel builds always have a validated Engine workspace selected above.
    return this.buildEngine({
      slug,
      gameDir,
      outDir,
      engineRoot: selectedEngine!.path,
      rebuildEngine,
      onProgress,
    });
  }

  /**
   * Engine (3D, non-reel) export.
   *
   * The Engine DevKit is the sole owner of project build orchestration. The
   * server supplies the user's game root, public-url base, and output root;
   * DevKit owns Vite, runtime injection, asset cooking, shader compilation,
   * Pack output, and the `forgeax-dist.json` closure.
   */
  private async buildEngine(args: {
    slug: string;
    gameDir: string;
    outDir: string;
    engineRoot: string;
    rebuildEngine?: boolean;
    onProgress?: (phase: string, line?: string) => void;
  }): Promise<PackageResult> {
    const { slug, gameDir, outDir, engineRoot, rebuildEngine, onProgress } = args;
    const devkitCli = engineDevkitCliPath(engineRoot);
    if (!existsSync(devkitCli)) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: 'Engine DevKit CLI not found',
        detail: devkitCli,
      };
    }

    // Bundle the game the server is actually running, not any Engine checkout
    // junction or sample project that happens to be present in the workspace.
    if (!existsSync(gameDir)) {
      return { ok: false, slug, platform: 'web', error: `game not found: ${friendlyPath(gameDir)}` };
    }

    onProgress?.('web-build', `bundling static site (engine root: ${friendlyPath(engineRoot)}) …`);
    const bunBin = process.execPath || 'bun';
    const packagedEnginePackageRoot = devkitCli === join(engineRoot, PACKAGED_ENGINE_DEVKIT_CLI_RELATIVE)
      ? join(engineRoot, 'node_modules', '@forgeax')
      : undefined;
    // Serialize per Engine workspace so concurrent exports queue instead of
    // racing shared Vite/DDC resources. DevKit itself owns output cleanup.
    return runExclusive(engineRoot, async (): Promise<PackageResult> => {
      try {
        const proc = Bun.spawn({
          cmd: [
            bunBin,
            devkitCli,
            'build',
            gameDir,
            '--base',
            './',
            '--out-dir',
            outDir,
            '--json',
          ],
          cwd: engineRoot,
          env: {
            ...process.env,
            ...(packagedEnginePackageRoot === undefined
              ? {}
              : { FORGEAX_ENGINE_PACKAGE_ROOT: packagedEnginePackageRoot }),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const envelope = parseDevkitEnvelope(stdout);
        if (code !== 0 || envelope?.ok !== true) {
          const detail = formatDevkitFailure(envelope, stdout, stderr);
          onProgress?.('web-build', `Engine DevKit failed (exit ${code}):\n${detail}`);
          return { ok: false, slug, platform: 'web', error: 'Engine DevKit build failed', detail };
        }
        // A successful command must leave both the browser entry and the
        // digest-bound artifact manifest. Without these, `/play/:slug` would
        // expose a partial directory as if it were a valid export.
        const indexPath = join(outDir, 'index.html');
        const distManifestPath = join(outDir, 'forgeax-dist.json');
        if (!existsSync(indexPath) || !existsSync(distManifestPath)) {
          const detail = `expected index.html and forgeax-dist.json under ${friendlyPath(outDir)}`;
          onProgress?.('web-build', detail);
          return { ok: false, slug, platform: 'web', error: 'Engine DevKit produced incomplete output', detail };
        }
        onProgress?.('web-build', 'done');
        return {
          ok: true,
          slug,
          platform: 'web',
          outDir: friendlyPath(outDir),
          rebuiltEngine: !!rebuildEngine,
          runHint: `/play/${slug}/`,
        };
      } catch (e) {
        return { ok: false, slug, platform: 'web', error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /** Reel (interactive-film) export — uses the legacy reel-src path as-is. */
  private async buildReel(args: {
    slug: string;
    outDir: string;
    root: string;
    onProgress?: (phase: string, line?: string) => void;
  }): Promise<PackageResult> {
    const { slug, outDir, root, onProgress } = args;
    const buildSrc = resolve(root, 'packages/build/reel-src');
    const scriptRel = 'export/build-reel-standalone.ts';

    if (!existsSync(resolve(buildSrc, scriptRel))) {
      return {
        ok: false,
        slug,
        platform: 'web',
        error: `export build script not found (packages/build/reel-src/${scriptRel})`,
      };
    }

    onProgress?.('web-build', 'bundling reel site …');
    const bunBin = process.execPath || 'bun';
    try {
      const proc = Bun.spawn({
        cmd: [bunBin, scriptRel, slug, outDir],
        cwd: buildSrc,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const tailLog = (stderr || stdout).split('\n').slice(-40).join('\n');
        onProgress?.('web-build', `build failed (exit ${code}):\n${tailLog}`);
        return { ok: false, slug, platform: 'web', error: 'standalone build failed', detail: tailLog };
      }
      onProgress?.('web-build', 'done');
      return {
        ok: true,
        slug,
        platform: 'web',
        outDir: friendlyPath(outDir),
        runHint: `cd ${friendlyPath(outDir)} && ./serve.sh   # then open http://localhost:8123`,
      };
    } catch (e) {
      return { ok: false, slug, platform: 'web', error: e instanceof Error ? e.message : String(e) };
    }
  }

}
