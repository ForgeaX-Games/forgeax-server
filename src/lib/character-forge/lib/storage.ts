import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type {
  CharacterManifest,
  CharacterListItem,
  PortraitView,
  RouterCtx,
  SpriteAction,
  SpriteSheetEntry,
} from '../types';
import { assertCharId, assertSlug, ForgeError } from './ids';

/**
 * All character assets live under
 *   <projectRoot>/.forgeax/games/<slug>/characters/<charId>/
 * which is already on the safe-path whitelist (packages/server/src/fs/safe-path.ts).
 * Storage helpers refuse paths that would escape this prefix — even if a caller
 * smuggles "..", because every path is built from validated slug + charId.
 */

export function charDir(ctx: RouterCtx, slug: string, charId: string): string {
  assertSlug(slug);
  assertCharId(charId);
  return resolve(ctx.projectRoot, '.forgeax', 'games', slug, 'characters', charId);
}

export function manifestPath(ctx: RouterCtx, slug: string, charId: string): string {
  return resolve(charDir(ctx, slug, charId), 'manifest.json');
}

export function gameCharsDir(ctx: RouterCtx, slug: string): string {
  assertSlug(slug);
  return resolve(ctx.projectRoot, '.forgeax', 'games', slug, 'characters');
}

/**
 * Best-effort make the parent directory tree for an asset. Returns an absolute
 * path that callers can pass to writeFile directly.
 */
export async function ensureAssetPath(absPath: string): Promise<string> {
  const dir = absPath.split(sep).slice(0, -1).join(sep);
  await mkdir(dir, { recursive: true });
  return absPath;
}

export async function loadManifest(ctx: RouterCtx, slug: string, charId: string): Promise<CharacterManifest> {
  const p = manifestPath(ctx, slug, charId);
  if (!existsSync(p)) {
    throw new ForgeError('character-not-found', `no manifest at ${p}`, 404);
  }
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as CharacterManifest;
  } catch (e) {
    throw new ForgeError('manifest-corrupt', `failed to parse manifest: ${(e as Error).message}`, 500);
  }
}

export async function saveManifest(
  ctx: RouterCtx,
  slug: string,
  manifest: CharacterManifest,
): Promise<string> {
  const p = manifestPath(ctx, slug, manifest.charId);
  await ensureAssetPath(p);
  manifest.updatedAt = new Date().toISOString();
  await writeFile(p, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return p;
}

export interface SavePortraitOpts {
  view: PortraitView;
  pngBytes: Uint8Array;
}

/**
 * Image vendors disagree on output format: Seedream typically returns JPEG
 * even when asked for PNG.  Sniff the first 4 bytes and pick the extension
 * that matches reality, so the disk file is truthful and content-type
 * negotiation works downstream.
 */
function sniffImageExt(bytes: Uint8Array): 'png' | 'jpg' | 'webp' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  return 'png';
}

export async function savePortraitFile(
  ctx: RouterCtx,
  slug: string,
  charId: string,
  opts: SavePortraitOpts,
): Promise<{ path: string; rel: string }> {
  const dir = charDir(ctx, slug, charId);
  const ext = sniffImageExt(opts.pngBytes);
  const rel = `portrait/${opts.view}.${ext}`;
  const abs = resolve(dir, rel);
  await ensureAssetPath(abs);
  await writeFile(abs, opts.pngBytes);
  return { path: abs, rel };
}

export async function saveSpriteSheet(
  ctx: RouterCtx,
  slug: string,
  charId: string,
  action: SpriteAction,
  pngBytes: Uint8Array,
): Promise<{ path: string; rel: string }> {
  const dir = charDir(ctx, slug, charId);
  const ext = sniffImageExt(pngBytes);
  const rel = `sprites/${action}/sheet.${ext}`;
  const abs = resolve(dir, rel);
  await ensureAssetPath(abs);
  await writeFile(abs, pngBytes);
  return { path: abs, rel };
}

export async function listCharacters(ctx: RouterCtx, slug: string): Promise<CharacterListItem[]> {
  const dir = gameCharsDir(ctx, slug);
  if (!existsSync(dir)) return [];
  const out: CharacterListItem[] = [];
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;
    const p = resolve(dir, entry, 'manifest.json');
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(await readFile(p, 'utf-8')) as CharacterManifest;
      const front = m.portrait?.front;
      out.push({
        charId: m.charId,
        name: m.name,
        role: (m as { role?: CharacterListItem['role'] }).role ?? 'hero',
        portraitUrl: front ? assetUrl(slug, m.charId, front) : null,
        createdAt: m.createdAt,
        hasSprites: Object.keys(m.sprites ?? {}).length > 0,
      });
    } catch {
      /* skip corrupt entry */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * Produce a URL the browser can fetch the asset bytes from.  /api/files only
 * returns text-wrapped content; the plugin owns its own /asset endpoint that
 * streams raw PNG / JSON bytes within the safe-path scope (see server.ts).
 */
export function assetUrl(slug: string, charId: string, rel: string): string {
  const safeRel = rel.replace(/^\/+/, '');
  // 2026-05-21 Phase 6 — 路由从 /api/wb/character-forge 改名为 /api/wb/character;
  // 旧前缀已删. 这里之前漏改, 导致 iframe 收到 manifest URL 后图 404, 用户
  // 看到"无法生图". 实际 image gen 后端跑通, 只是路径名残留。
  return `/api/wb/character/asset?path=${encodeURIComponent(
    `.forgeax/games/${slug}/characters/${charId}/${safeRel}`,
  )}`;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
