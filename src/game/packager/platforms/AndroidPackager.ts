/**
 * Android platform packager — exports a standard, offline-syncable
 * Android Studio project (Gradle wrapper + WebViewAssetLoader native shell +
 * the full web game in assets/public/). It does NOT build an APK/AAB; the user
 * opens the exported folder in Android Studio to integrate SDKs and compile.
 *
 * Strategy:
 *   1. Validate user config (applicationId / project name / icon).
 *   2. WebPackager: build the static game into a temp dir (reuses engine +
 *      optional engine-core rebuild).
 *   3. Copy `packages/build/android-template` → `.forgeax/exports/<slug>-android/`.
 *   4. Inject the web product into `app/src/main/assets/public/`.
 *   5. String-replace applicationId / app_name / rootProject.name + write icon.
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

/** A valid Android applicationId: ≥2 dot-separated segments, each starts with a letter. */
const APP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Gradle rootProject.name — keep it filesystem/identifier-safe. */
const PROJECT_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

export class AndroidPackager implements IGamePackager {
  readonly platform = 'android' as const;
  private webPackager = new WebPackager();

  async build(opts: PackageOptions): Promise<PackageResult> {
    const { slug, gameDir, projectRoot, onProgress, forceRebuild } = opts;
    const t0 = Date.now();
    const androidOutDir = resolve(projectRoot, '.forgeax/exports', `${slug}-android`);
    const webTmpDir = resolve(projectRoot, '.forgeax/exports', `.${slug}-android-web`);
    const templateDir = resolve(studioRoot(), 'packages/build/android-template');

    const fail = (error: string, detail?: string): PackageResult => {
      const rec = appendHistory({
        slug, platform: 'android', status: 'failed', durationMs: Date.now() - t0, error,
      });
      return { ok: false, slug, platform: 'android', error, detail: detail ?? `history: ${rec.id}` };
    };

    if (!existsSync(templateDir)) {
      return fail('Android template missing', `expected at ${friendlyPath(templateDir)}`);
    }

    // ── Resolve + validate user config ──
    const appId = (opts.androidAppId?.trim()) || defaultAppId(slug);
    if (!APP_ID_RE.test(appId)) {
      return fail(`invalid applicationId: "${appId}"`, 'expected e.g. com.acme.mygame');
    }
    const projectName = (opts.androidProjectName?.trim()) || slug;
    if (!PROJECT_NAME_RE.test(projectName)) {
      return fail(`invalid project name: "${projectName}"`, 'only letters, digits, "-" and "_"');
    }
    const appName = (opts.androidAppName?.trim()) || this.readGameName(gameDir, slug);
    // Locked launch orientation → AndroidManifest android:screenOrientation.
    // Unknown/absent falls back to "landscape" (the default for game exports).
    const screenOrientation =
      opts.androidOrientation === 'portrait' ? 'portrait'
      : 'landscape';

    // ── Validate icon (if provided) ──
    let iconBytes: Buffer | undefined;
    if (opts.androidIcon?.dataBase64) {
      try {
        iconBytes = Buffer.from(opts.androidIcon.dataBase64, 'base64');
      } catch {
        return fail('icon decode failed', 'expected base64 PNG');
      }
      if (!isPng(iconBytes)) return fail('icon must be a PNG image');
      if (iconBytes.length > MAX_ICON_BYTES) {
        return fail(`icon too large (${(iconBytes.length / 1024 / 1024).toFixed(1)} MB > 2 MB)`);
      }
    }

    // ── forceRebuild cleanup ──
    if (forceRebuild && existsSync(androidOutDir)) {
      onProgress?.('cleanup', 'cleaning previous build …');
      rmSync(androidOutDir, { recursive: true, force: true });
    }

    try {
      // ── Step 1: web build into temp dir ──
      onProgress?.('export-android-project', 'building web artefacts …');
      if (existsSync(webTmpDir)) rmSync(webTmpDir, { recursive: true, force: true });
      const webResult = await this.webPackager.build({ ...opts, outDir: webTmpDir });
      if (!webResult.ok) {
        appendHistory({
          slug, platform: 'android', status: 'failed', durationMs: Date.now() - t0,
          error: webResult.error, rebuiltEngine: webResult.rebuiltEngine,
        });
        return { ...webResult, platform: 'android' };
      }

      // ── Step 2: copy template ──
      onProgress?.('export-android-project', 'assembling Android Studio project …');
      if (existsSync(androidOutDir)) rmSync(androidOutDir, { recursive: true, force: true });
      mkdirSync(dirname(androidOutDir), { recursive: true });
      cpSync(templateDir, androidOutDir, { recursive: true });

      // ── Step 3: inject web product into assets/public ──
      const assetsPublic = join(androidOutDir, 'app', 'src', 'main', 'assets', 'public');
      rmSync(assetsPublic, { recursive: true, force: true });
      mkdirSync(assetsPublic, { recursive: true });
      cpSync(webTmpDir, assetsPublic, { recursive: true });
      rmSync(webTmpDir, { recursive: true, force: true });

      // ── Step 3b: sanitize dot-prefixed asset filenames referenced by index.html ──
      sanitizeDotAssets(assetsPublic);

      // ── Step 4: apply config (string replacement) ──
      onProgress?.('export-android-project', 'applying app config …');
      replaceInFile(join(androidOutDir, 'app', 'build.gradle.kts'), '__FORGEAX_APPLICATION_ID__', appId);
      replaceInFile(join(androidOutDir, 'settings.gradle.kts'), '__FORGEAX_PROJECT_NAME__', projectName);
      // The template ships a valid default ("unspecified") so it stays
      // schema-valid in Android Studio; swap in the chosen orientation here.
      replaceInFile(
        join(androidOutDir, 'app', 'src', 'main', 'AndroidManifest.xml'),
        'android:screenOrientation="unspecified"',
        `android:screenOrientation="${screenOrientation}"`,
      );
      replaceInFile(
        join(androidOutDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
        '__FORGEAX_APP_NAME__',
        xmlEscape(appName),
      );

      // ── Step 5: icon — replace the vector placeholder with a PNG ──
      if (iconBytes) {
        const drawableDir = join(androidOutDir, 'app', 'src', 'main', 'res', 'drawable');
        rmSync(join(drawableDir, 'app_icon.xml'), { force: true });
        writeFileSync(join(drawableDir, 'app_icon.png'), iconBytes);
      }

      const outDirFriendly = friendlyPath(androidOutDir);
      const durationMs = Date.now() - t0;
      appendHistory({
        slug, platform: 'android', status: 'success', durationMs,
        outDir: outDirFriendly, rebuiltEngine: webResult.rebuiltEngine,
      });
      onProgress?.('done', `exported in ${(durationMs / 1000).toFixed(1)}s`);

      return {
        ok: true,
        slug,
        platform: 'android',
        outDir: outDirFriendly,
        runHint: 'Open this folder in Android Studio to integrate SDKs and build APK/AAB.',
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
 * Android's aapt2 drops dotfiles from the packaged APK (its default
 * ignoreAssetsPattern contains the `.*` rule). The shared web build names its
 * entry chunk after the generated html (`.export-gen.index-[hash].js`), so it
 * ships with a leading dot and 404s at runtime → WebView black screen. Rename
 * the dot-prefixed files that `index.html` directly references and rewrite those
 * references. Only html-referenced files are touched; GUID-referenced
 * game-assets are left as-is (the build.gradle.kts aaptOptions override keeps
 * those shipping).
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

/** Derive a sane default applicationId from a slug. */
function defaultAppId(slug: string): string {
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
