/**
 * iOS platform packager — exports a standard Xcode project (a UIKit app whose
 * whole UI is a full-screen WKWebView + the full web game under
 * `ForgeaxPlayer/public/`). It does NOT build an IPA; the user opens the
 * exported folder in Xcode on macOS, configures signing, and archives.
 *
 * Strategy (mirrors AndroidPackager):
 *   1. Validate user config (bundleId / project name / app name / icon).
 *   2. WebPackager: build the static game into a temp dir (reuses engine +
 *      optional engine-core rebuild).
 *   3. Copy `packages/build/ios-template` -> `.forgeax/exports/<slug>-ios/`.
 *   4. Inject the web product into `ForgeaxPlayer/public/`.
 *   5. String-replace bundleId (project.pbxproj) + app name / orientation
 *      (Info.plist); rename the `.xcodeproj` to the chosen project name; write
 *      the launcher icon.
 *   6. Record history.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import type { IGamePackager, PackageOptions, PackageResult } from '../IGamePackager';
import { friendlyPath, assetRoot } from '@forgeax/platform-io';
import { WebPackager } from './WebPackager';
import { appendHistory } from '../history';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

/** A valid reverse-DNS bundle identifier: >=2 dot-separated segments. */
const BUNDLE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Xcode project name — keep it filesystem/identifier-safe. */
const PROJECT_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

export class IosPackager implements IGamePackager {
  readonly platform = 'ios' as const;
  private webPackager = new WebPackager();

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, projectRoot, onProgress, forceRebuild } = opts;
    const t0 = Date.now();
    const iosOutDir = resolve(projectRoot, '.forgeax/exports', `${slug}-ios`);
    const webTmpDir = resolve(projectRoot, '.forgeax/exports', `.${slug}-ios-web`);
    const templateDir = resolve(studioRoot(), 'packages/build/ios-template');

    const fail = (error: string, detail?: string): PackageResult => {
      const rec = appendHistory({
        slug, platform: 'ios', status: 'failed', durationMs: Date.now() - t0, error,
      });
      return { ok: false, slug, platform: 'ios', error, detail: detail ?? `history: ${rec.id}` };
    };

    if (!existsSync(templateDir)) {
      return fail('iOS template missing', `expected at ${friendlyPath(templateDir)}`);
    }

    // ── Resolve + validate user config ──
    const bundleId = (opts.iosBundleId?.trim()) || defaultBundleId(slug);
    if (!BUNDLE_ID_RE.test(bundleId)) {
      return fail(`invalid bundle identifier: "${bundleId}"`, 'expected e.g. com.acme.mygame');
    }
    const projectName = (opts.iosProjectName?.trim()) || slug;
    if (!PROJECT_NAME_RE.test(projectName)) {
      return fail(`invalid project name: "${projectName}"`, 'only letters, digits, "-" and "_"');
    }
    const appName = (opts.iosAppName?.trim()) || this.readGameName(gameDir, slug);
    // Locked launch orientation → Info.plist UISupportedInterfaceOrientations.
    // Unknown/absent falls back to "landscape" (the default for game exports).
    const orientation = opts.iosOrientation === 'portrait' ? 'portrait' : 'landscape';

    // ── Validate icon (if provided) ──
    let iconBytes: Buffer | undefined;
    if (opts.iosIcon?.dataBase64) {
      try {
        iconBytes = Buffer.from(opts.iosIcon.dataBase64, 'base64');
      } catch {
        return fail('icon decode failed', 'expected base64 PNG');
      }
      if (!isPng(iconBytes)) return fail('icon must be a PNG image');
      if (iconBytes.length > MAX_ICON_BYTES) {
        return fail(`icon too large (${(iconBytes.length / 1024 / 1024).toFixed(1)} MB > 2 MB)`);
      }
    }

    // ── forceRebuild cleanup ──
    if (forceRebuild && existsSync(iosOutDir)) {
      onProgress?.('cleanup', 'cleaning previous build …');
      rmSync(iosOutDir, { recursive: true, force: true });
    }

    try {
      // ── Step 1: web build into temp dir ──
      onProgress?.('export-ios-project', 'building web artefacts …');
      if (existsSync(webTmpDir)) rmSync(webTmpDir, { recursive: true, force: true });
      const webResult = await this.webPackager.build({ ...opts, outDir: webTmpDir });
      if (!webResult.ok) {
        appendHistory({
          slug, platform: 'ios', status: 'failed', durationMs: Date.now() - t0,
          error: webResult.error, rebuiltEngine: webResult.rebuiltEngine,
        });
        return { ...webResult, platform: 'ios' };
      }

      // ── Step 2: copy template ──
      onProgress?.('export-ios-project', 'assembling Xcode project …');
      if (existsSync(iosOutDir)) rmSync(iosOutDir, { recursive: true, force: true });
      mkdirSync(dirname(iosOutDir), { recursive: true });
      cpSync(templateDir, iosOutDir, { recursive: true });

      // ── Step 3: inject web product into ForgeaxPlayer/public ──
      const publicDir = join(iosOutDir, 'ForgeaxPlayer', 'public');
      rmSync(publicDir, { recursive: true, force: true });
      mkdirSync(publicDir, { recursive: true });
      cpSync(webTmpDir, publicDir, { recursive: true });
      rmSync(webTmpDir, { recursive: true, force: true });

      // ── Step 3b: sanitize dot-prefixed asset filenames referenced by index.html ──
      // Xcode's "Copy Bundle Resources" (and folder-reference copying) can drop
      // dot-prefixed files; the shared web build names its entry chunk
      // `.export-gen.index-[hash].js`. Rename html-referenced dotfiles + rewrite
      // the references so they resolve at runtime.
      sanitizeDotAssets(publicDir);

      // ── Step 4: apply config ──
      onProgress?.('export-ios-project', 'applying app config …');
      replaceInFile(
        join(iosOutDir, 'ForgeaxPlayer.xcodeproj', 'project.pbxproj'),
        '__FORGEAX_BUNDLE_ID__',
        bundleId,
      );
      const infoPlist = join(iosOutDir, 'ForgeaxPlayer', 'Info.plist');
      replaceInFile(infoPlist, '__FORGEAX_APP_NAME__', xmlEscape(appName));
      replaceInFile(infoPlist, '__FORGEAX_ORIENTATIONS__', orientationsXml(orientation));

      // ── Step 4b: rename the .xcodeproj to the chosen project name ──
      // The pbxproj never hardcodes its own containing folder name, but the
      // shared scheme's `ReferencedContainer` DOES (container:ForgeaxPlayer.xcodeproj).
      // Renaming the project without rewriting that reference leaves the scheme
      // pointing at a container that no longer exists — Xcode then can't resolve
      // the scheme's buildable and greys out Run/Build.
      if (projectName !== 'ForgeaxPlayer') {
        const from = join(iosOutDir, 'ForgeaxPlayer.xcodeproj');
        const to = join(iosOutDir, `${projectName}.xcodeproj`);
        if (existsSync(from) && !existsSync(to)) renameSync(from, to);
        // Point the shared scheme at the renamed container (all 3 occurrences)
        // and rename the scheme so Xcode surfaces it under the project name.
        const schemesDir = join(iosOutDir, `${projectName}.xcodeproj`, 'xcshareddata', 'xcschemes');
        const schemeFrom = join(schemesDir, 'ForgeaxPlayer.xcscheme');
        if (existsSync(schemeFrom)) {
          replaceInFile(schemeFrom, 'container:ForgeaxPlayer.xcodeproj', `container:${projectName}.xcodeproj`);
          const schemeTo = join(schemesDir, `${projectName}.xcscheme`);
          if (!existsSync(schemeTo)) renameSync(schemeFrom, schemeTo);
        }
      }

      // ── Step 5: icon — write PNG into the AppIcon asset set ──
      if (iconBytes) {
        const iconSet = join(iosOutDir, 'ForgeaxPlayer', 'Assets.xcassets', 'AppIcon.appiconset');
        writeFileSync(join(iconSet, 'app_icon.png'), iconBytes);
        writeFileSync(join(iconSet, 'Contents.json'), appIconContents('app_icon.png'));
      }

      const outDirFriendly = friendlyPath(iosOutDir);
      const durationMs = Date.now() - t0;
      appendHistory({
        slug, platform: 'ios', status: 'success', durationMs,
        outDir: outDirFriendly, rebuiltEngine: webResult.rebuiltEngine,
      });
      onProgress?.('done', `exported in ${(durationMs / 1000).toFixed(1)}s`);

      return {
        ok: true,
        slug,
        platform: 'ios',
        outDir: outDirFriendly,
        runHint: 'Open this folder in Xcode (macOS), set your signing Team, then Product → Archive to export an IPA.',
        rebuiltEngine: webResult.rebuiltEngine,
      };
    } catch (e) {
      rmSync(webTmpDir, { recursive: true, force: true });
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  private readGameName(gameDir: string, fallback: string): string {
    try {
      const forge = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf-8')) as { name?: string };
      return forge.name ?? fallback;
    } catch {
      return fallback;
    }
  }
}

/**
 * iOS folder-reference copying can drop dot-prefixed files; the shared web
 * build ships its entry chunk under `.export-gen.index-[hash].js`. Rename the
 * dot-prefixed files that `index.html` directly references and rewrite those
 * references. Only html-referenced files are touched; GUID-referenced
 * game-assets are left as-is (served fine over the custom scheme).
 */
function sanitizeDotAssets(publicDir: string): void {
  const htmlPath = join(publicDir, 'index.html');
  if (!existsSync(htmlPath)) return;
  let html = readFileSync(htmlPath, 'utf-8');
  const re = /(?:src|href)="(\.\/[^"]+)"/g;
  const renames = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const relUrl = m[1];
    const base = relUrl.split('/').pop() ?? '';
    if (!base.startsWith('.')) continue;
    const newBase = base.replace(/^\.+/, '');
    if (!newBase) continue;
    const dir = relUrl.slice(0, relUrl.length - base.length);
    renames.set(relUrl, dir + newBase);
  }
  for (const [oldUrl, newUrl] of renames) {
    const oldFs = join(publicDir, oldUrl.replace(/^\.\//, ''));
    const newFs = join(publicDir, newUrl.replace(/^\.\//, ''));
    if (existsSync(oldFs)) renameSync(oldFs, newFs);
    html = html.split(oldUrl).join(newUrl);
  }
  if (renames.size > 0) writeFileSync(htmlPath, html);
}

/** UISupportedInterfaceOrientations entries for the locked orientation. */
function orientationsXml(orientation: 'portrait' | 'landscape'): string {
  if (orientation === 'portrait') {
    return '<string>UIInterfaceOrientationPortrait</string>';
  }
  return [
    '<string>UIInterfaceOrientationLandscapeLeft</string>',
    '\t\t<string>UIInterfaceOrientationLandscapeRight</string>',
  ].join('\n');
}

/** AppIcon.appiconset Contents.json pointing at a single 1024 universal PNG. */
function appIconContents(filename: string): string {
  return `${JSON.stringify({
    images: [{ idiom: 'universal', platform: 'ios', size: '1024x1024', filename }],
    info: { author: 'xcode', version: 1 },
  }, null, 2)}\n`;
}

/** Derive a sane default bundle identifier from a slug. */
function defaultBundleId(slug: string): string {
  let seg = slug.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!seg) seg = 'app';
  if (/^[0-9]/.test(seg)) seg = `g${seg}`;
  return `com.forgeax.game.${seg}`;
}

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function replaceInFile(file: string, token: string, value: string): void {
  const text = readFileSync(file, 'utf-8');
  writeFileSync(file, text.split(token).join(value));
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
