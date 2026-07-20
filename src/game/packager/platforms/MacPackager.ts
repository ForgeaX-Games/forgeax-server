/**
 * macOS platform packager — produces a standalone game folder with a reusable
 * launcher binary + `_web/` site + a double-clickable `Play <name>.command`.
 *
 * Strategy (mirrors WindowsPackager):
 *   1. ShellProvider: build (or retrieve from cache) the universal launcher for
 *      the host arch via `bun build --compile` (no --target). No Rust required.
 *   2. WebPackager: generate the static site into `_web/`.
 *   3. Copy the launcher binary (chmod +x) + write config + a `.command` wrapper
 *      so users can double-click to play in Finder.
 *
 * The launcher (packages/build/player-launcher/player-launcher.ts) serves _web/
 * over 127.0.0.1 (secure context for WebGPU) and opens the default browser on
 * macOS.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { IGamePackager, PackageOptions, PackageResult } from '../IGamePackager';
import { friendlyPath } from '@forgeax/platform-io';
import { WebPackager } from './WebPackager';
import { getOrBuildShell } from '../shell/ShellProvider';
import { appendHistory } from '../history';

export class MacPackager implements IGamePackager {
  readonly platform = 'macos' as const;
  private webPackager = new WebPackager();

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, projectRoot, onProgress, forceRebuild } = opts;
    const t0 = Date.now();
    const macOutDir = resolve(projectRoot, '.forgeax/exports', `${slug}-macos`);
    const webOutDir = resolve(macOutDir, '_web');
    const cacheDir = join(homedir(), '.forgeax', 'cache');

    if (forceRebuild && existsSync(macOutDir)) {
      onProgress?.('cleanup', 'cleaning previous build …');
      rmSync(macOutDir, { recursive: true, force: true });
    }

    // Step 1: acquire the launcher binary (host arch)
    onProgress?.('shell', 'acquiring launcher shell …');
    const shell = await getOrBuildShell(cacheDir, 'macos', onProgress, forceRebuild);
    if (!shell.ok || !shell.exePath) {
      const rec = appendHistory({
        slug,
        platform: 'macos',
        status: 'failed',
        durationMs: Date.now() - t0,
        error: shell.error ?? 'shell build failed',
      });
      return {
        ok: false, slug, platform: 'macos',
        error: shell.error ?? 'failed to build launcher shell',
        detail: `history: ${rec.id}`,
      };
    }

    // Step 2: web build (with optional engine rebuild)
    onProgress?.('web-build', 'building web artefacts …');
    const webResult = await this.webPackager.build({ ...opts, outDir: webOutDir });
    if (!webResult.ok) {
      appendHistory({
        slug,
        platform: 'macos',
        status: 'failed',
        durationMs: Date.now() - t0,
        error: webResult.error,
        usedCachedShell: shell.cached,
        rebuiltEngine: webResult.rebuiltEngine,
      });
      return { ...webResult, platform: 'macos' };
    }

    // Step 3: assemble
    onProgress?.('assemble', 'assembling macOS package …');
    mkdirSync(macOutDir, { recursive: true });

    const binName = this.sanitizeName(slug);
    const binPath = join(macOutDir, binName);
    cpSync(shell.exePath, binPath);
    try { chmodSync(binPath, 0o755); } catch { /* best effort */ }

    const gameName = this.readGameName(gameDir, slug);
    writeFileSync(
      join(macOutDir, 'forgeax-player.json'),
      JSON.stringify({ title: gameName, webRoot: './_web', port: 0 }),
    );

    // Double-clickable wrapper: Finder runs .command files in Terminal, cd'ing
    // into the folder first so the launcher finds _web/ next to the binary.
    const commandName = `Play ${gameName}.command`;
    const commandPath = join(macOutDir, commandName);
    writeFileSync(
      commandPath,
      `#!/bin/bash\ncd "$(dirname "$0")"\nexec "./${binName}"\n`,
    );
    try { chmodSync(commandPath, 0o755); } catch { /* best effort */ }

    const outDirFriendly = friendlyPath(macOutDir);
    const durationMs = Date.now() - t0;

    appendHistory({
      slug,
      platform: 'macos',
      status: 'success',
      durationMs,
      outDir: outDirFriendly,
      usedCachedShell: shell.cached,
      rebuiltEngine: webResult.rebuiltEngine,
    });

    onProgress?.('done', `packaged in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      ok: true,
      slug,
      platform: 'macos',
      outDir: outDirFriendly,
      runHint: `Double-click "${commandName}" in ${outDirFriendly}`,
      usedCachedShell: shell.cached,
      rebuiltEngine: webResult.rebuiltEngine,
    };
  }

  private readGameName(gameDir: string, fallback: string): string {
    try {
      const forge = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf-8')) as { name?: string };
      return forge.name ?? fallback;
    } catch {
      return fallback;
    }
  }

  private sanitizeName(slug: string): string {
    return slug.replace(/[^a-zA-Z0-9-]/g, '-');
  }
}
