/**
 * character-forge —— plain-function handler SSOT.
 *
 * Two parallel consumers share this module:
 *   1. packages/server/src/api/wb-character.ts —— Hono router thin-wraps each endpoint
 *   2. packages/server/builtin/{commands,kits}/character-forge/*.ts
 *      —— agent / CLI / cron 直接调 handler 拿 JSON,不走 HTTP
 *
 * 两路径共享同一份业务实现 + 同一个 character-forge.* 事件名 —— ledger / ws 看到的
 * 事件形状统一,与 caller 无关。
 *
 * HandlerCtx 字段 = RouterCtx 字段（projectRoot / env / emit?）.
 *
 * 历史:文件曾位于 packages/marketplace/plugins/wb-character-forge/src/handlers.ts,
 * 2026-05-21 Phase 6 plugin shell 删除时搬来 host-level shared lib。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImageDispatcher } from './clients/dispatcher';
import { buildPortraitPrompt, getStylePreset, STYLE_IDS } from './prompts/portrait';
import { buildSpriteSheetPrompt } from './prompts/sprite';
import { assertCharId, assertSlug, deriveCharId, deriveName, ForgeError } from './lib/ids';
import {
  assetUrl,
  charDir,
  fileExists,
  listCharacters as listCharactersStorage,
  loadManifest,
  manifestPath as manifestPathOf,
  savePortraitFile,
  saveManifest,
  saveSpriteSheet,
} from './lib/storage';
import type {
  CharacterListItem,
  CharacterManifest,
  CharacterManifestV2,
  CharacterRole,
  GeneratePortraitArgs,
  GeneratePortraitResult,
  GenerateSpriteSheetArgs,
  GenerateSpriteSheetResult,
  PortraitView,
  RouterCtx,
  SpriteDirection,
  StylePreset,
  UpsertManifestArgs,
  UpsertManifestResult,
} from './types';

export { ForgeError };
export type HandlerCtx = RouterCtx;

const VALID_VIEWS: PortraitView[] = ['front', 'side', 'back'];
const VALID_DIRS: SpriteDirection[] = ['down', 'left', 'right', 'up'];

const PORTRAIT_TIMEOUT_MS = 90_000;
const SPRITE_TIMEOUT_MS = 120_000;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new ForgeError('timeout', `${label} exceeded ${ms}ms`, 504)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

function friendly(p: string, root: string): string {
  const rel = resolve(p);
  if (!rel.startsWith(root)) return p;
  const r = rel.slice(root.length);
  return r.startsWith('/') ? r.slice(1) : r;
}

// v1 manifests on disk get an empty `pipelines` map and a `schemaVersion: 2`
// bump on the next write. We never delete v1 manifests in place — only the
// next mutation (portrait/sprite/rename) flushes them forward. Read-only
// callers (getCharacter, listCharacters) still see the upgraded shape.
export function upgradeManifestToLatest(m: CharacterManifest): CharacterManifestV2 {
  if (m.schemaVersion === 2) return m;
  return { ...m, schemaVersion: 2, pipelines: {} };
}

// Per-ctx dispatcher cache —— 同一 ctx.env 复用同一个 ImageDispatcher（包含
// vendor SDK 实例 + key 状态）,避免每次 handler call 重新构造。projectRoot
// 用作弱键足够 —— forgeax-server 只跑一个 projectRoot,plugin host 注入一个 env。
const dispatcherCache = new WeakMap<HandlerCtx, ImageDispatcher>();
function dispatcherFor(ctx: HandlerCtx): ImageDispatcher {
  let d = dispatcherCache.get(ctx);
  if (!d) {
    d = new ImageDispatcher(ctx.env);
    dispatcherCache.set(ctx, d);
  }
  return d;
}

export interface StatusResult {
  plugin: string;
  version: string;
  vendors: ReturnType<ImageDispatcher['isReady']>;
  styles: typeof STYLE_IDS;
  now: string;
}

export function getStatus(ctx: HandlerCtx): StatusResult {
  return {
    plugin: '@forgeax-plugin/wb-character',
    version: '0.1.0',
    vendors: dispatcherFor(ctx).isReady(),
    styles: STYLE_IDS,
    now: new Date().toISOString(),
  };
}

export async function listCharacters(ctx: HandlerCtx, slug: string): Promise<{ slug: string; items: CharacterListItem[] }> {
  const s = assertSlug(slug);
  const items = await listCharactersStorage(ctx, s);
  return { slug: s, items };
}

export async function getCharacter(
  ctx: HandlerCtx,
  slug: string,
  charId: string,
): Promise<{ manifest: CharacterManifestV2; urls: Record<string, string> }> {
  const s = assertSlug(slug);
  const c = assertCharId(charId);
  const manifest = upgradeManifestToLatest(await loadManifest(ctx, s, c));
  const urls: Record<string, string> = {};
  for (const [view, rel] of Object.entries(manifest.portrait ?? {})) {
    if (rel) urls[`portrait/${view}`] = assetUrl(s, c, rel);
  }
  for (const [action, sheet] of Object.entries(manifest.sprites ?? {})) {
    if (sheet?.sheet) urls[`sprites/${action}`] = assetUrl(s, c, sheet.sheet);
  }
  return { manifest, urls };
}

/**
 * 登记/合并一份角色 manifest(不在 server 端生图)。供 wb-character 前端在
 * 客户端管线产出最终设定图、字节已经通过 /upload-asset 落盘之后调用,把角色
 * 写进 manifest.json,从而被 listCharacters / 下游 wb-anim 发现。
 *
 * 幂等:已存在 manifest 时只合并 name/role/portrait,不清空既有 pipelines。
 */
export async function upsertManifest(
  ctx: HandlerCtx,
  body: UpsertManifestArgs,
): Promise<UpsertManifestResult> {
  const slug = assertSlug(body.slug);
  const charId = assertCharId(body.charId);
  const role = (body.role ?? 'hero') as CharacterRole;
  const nowIso = new Date().toISOString();

  let manifest: CharacterManifestV2;
  const existingPath = manifestPathOf(ctx, slug, charId);
  if (existsSync(existingPath)) {
    manifest = upgradeManifestToLatest(await loadManifest(ctx, slug, charId));
    if (body.name?.trim()) manifest.name = body.name.trim();
    manifest.role = role;
  } else {
    manifest = {
      schemaVersion: 2,
      charId,
      name: body.name?.trim() || charId,
      role,
      createdAt: nowIso,
      updatedAt: nowIso,
      prompt: { user: body.promptText ?? '', style: 'anime-hd-flat', refImage: null },
      portrait: {},
      sprites: {},
      variants: [],
      pipelines: {},
    };
  }

  if (body.portrait) {
    manifest.portrait = { ...manifest.portrait, ...body.portrait };
  }
  if (body.portraitFront) {
    manifest.portrait.front = body.portraitFront;
  }

  const manifestAbs = await saveManifest(ctx, slug, manifest);

  ctx.emit?.('character-forge.manifest.upserted', { slug, charId, role });

  const front = manifest.portrait.front;
  return {
    charId,
    name: manifest.name,
    role,
    manifestPath: friendly(manifestAbs, ctx.projectRoot),
    portraitUrl: front ? assetUrl(slug, charId, front) : null,
  };
}

export async function generatePortrait(
  ctx: HandlerCtx,
  body: GeneratePortraitArgs,
): Promise<GeneratePortraitResult> {
  const dispatcher = dispatcherFor(ctx);
  const slug = assertSlug(body.slug);
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) throw new ForgeError('empty-prompt', 'prompt is required');
  const style = (body.style ?? 'anime-hd-flat') as StylePreset;
  const views = body.views?.length
    ? body.views.filter((v): v is PortraitView => VALID_VIEWS.includes(v))
    : ['front' as PortraitView];
  if (views.length === 0) throw new ForgeError('invalid-views', 'at least one view required');

  const charId = body.charId ? assertCharId(body.charId) : deriveCharId(prompt);
  const name = body.name?.trim() || deriveName(prompt);
  const nowIso = new Date().toISOString();

  let manifest: CharacterManifest;
  const existingPath = manifestPathOf(ctx, slug, charId);
  if (existsSync(existingPath)) {
    manifest = upgradeManifestToLatest(await loadManifest(ctx, slug, charId));
  } else {
    manifest = {
      schemaVersion: 2,
      charId,
      name,
      createdAt: nowIso,
      updatedAt: nowIso,
      prompt: { user: prompt, style, refImage: body.refImageBase64 ?? null },
      portrait: {},
      sprites: {},
      variants: [],
      pipelines: {},
    };
  }

  const files: GeneratePortraitResult['files'] = [];
  let lastModel = '';
  let consistencyHint: string | undefined;
  for (const view of views) {
    const promptText = buildPortraitPrompt({
      userDescription: prompt,
      style: getStylePreset(style),
      view,
      consistencyHint,
    });
    const dispatchPromise = dispatcher.generate('concept-art', {
      prompt: promptText,
      size: body.size ?? '2k',
      refImageBase64: body.refImageBase64,
    }, body.model);
    const r2 = await withTimeout(dispatchPromise, PORTRAIT_TIMEOUT_MS, `portrait:${view}`);
    const { rel } = await savePortraitFile(ctx, slug, charId, { view, pngBytes: r2.pngBytes });
    manifest.portrait[view] = rel;
    files.push({ view, path: rel, url: assetUrl(slug, charId, rel) });
    lastModel = `${r2.vendor}/${r2.modelId}`;
    if (!consistencyHint) {
      consistencyHint = `Same character as the ${view} portrait: ${prompt}.`;
    }
  }

  const manifestAbs = await saveManifest(ctx, slug, manifest);

  ctx.emit?.('character-forge.portrait.generated', {
    slug, charId, name, views, model: lastModel, fileCount: files.length,
  });

  return {
    charId,
    name,
    files,
    manifestPath: friendly(manifestAbs, ctx.projectRoot),
    model: lastModel,
    costEstimate: { usd: 0.04 * files.length, vendor: lastModel.split('/')[0] || 'unknown' },
  };
}

export async function generateSpriteSheet(
  ctx: HandlerCtx,
  body: GenerateSpriteSheetArgs,
): Promise<GenerateSpriteSheetResult> {
  const dispatcher = dispatcherFor(ctx);
  const slug = assertSlug(body.slug);
  const charId = assertCharId(body.charId);
  const action = body.action ?? 'walk';
  const directions = body.directions?.length
    ? body.directions.filter((d): d is SpriteDirection => VALID_DIRS.includes(d))
    : VALID_DIRS;
  const framesPerDir = clamp(body.framesPerDir ?? 4, 2, 8);
  const frameSize = (body.frameSize ?? 96) as 64 | 96 | 128;

  const manifest = upgradeManifestToLatest(await loadManifest(ctx, slug, charId));
  const portraitRel = manifest.portrait.front;
  let refBase64: string | undefined;
  if (portraitRel) {
    const portraitAbs = resolve(charDir(ctx, slug, charId), portraitRel);
    if (await fileExists(portraitAbs)) {
      const bytes = await readFile(portraitAbs);
      refBase64 = Buffer.from(bytes).toString('base64');
    }
  }

  const promptText = buildSpriteSheetPrompt({
    userDescription: manifest.prompt.user,
    style: manifest.prompt.style,
    action,
    directions,
    framesPerDir,
    hasReferenceImage: Boolean(refBase64),
  });

  const r2 = await withTimeout(
    dispatcher.generate('sprite-frame', {
      prompt: promptText,
      size: '2k',
      refImageBase64: refBase64,
    }, body.model),
    SPRITE_TIMEOUT_MS,
    `sprite-sheet:${action}`,
  );
  const { rel } = await saveSpriteSheet(ctx, slug, charId, action, r2.pngBytes);

  manifest.sprites[action] = {
    sheet: rel,
    framesPerDir,
    directions,
    frameSize: { w: frameSize, h: frameSize },
    generatedAt: new Date().toISOString(),
  };
  await saveManifest(ctx, slug, manifest);

  ctx.emit?.('character-forge.sprite.generated', {
    slug, charId, action, model: `${r2.vendor}/${r2.modelId}`, directions: directions.length,
  });

  return {
    charId,
    action,
    sheet: { path: rel, url: assetUrl(slug, charId, rel) },
    atlas: directions.map((dir) => ({ dir, framesPerDir, frameSize })),
  };
}

export async function renameCharacter(
  ctx: HandlerCtx,
  slug: string,
  charId: string,
  name: string,
): Promise<{ ok: true; name: string }> {
  const s = assertSlug(slug);
  const c = assertCharId(charId);
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.length > 80) {
    throw new ForgeError('invalid-name', 'name must be 1-80 chars');
  }
  const manifest = upgradeManifestToLatest(await loadManifest(ctx, s, c));
  manifest.name = trimmed;
  await saveManifest(ctx, s, manifest);
  ctx.emit?.('character-forge.character.renamed', { slug: s, charId: c, name: trimmed });
  return { ok: true, name: trimmed };
}
