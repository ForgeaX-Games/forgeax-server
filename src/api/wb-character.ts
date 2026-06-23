/**
 * /api/wb/character —— ForgeaX 角色编辑器统一 API。
 *
 * 五条「立绘 + 行动小人」管线沿用 character-forge 的 handlers.ts SSOT (走
 * @server-lib/character-forge tsconfig 别名,文件位于
 * packages/server/src/lib/character-forge/)。剩下七条 (pixel/spine/
 * vfx/monster/video/turnaround/vehicle) 目前 501 stub,留 charId/slug 参数
 * 形状一致,后续 plugin submodule build dist 接入。
 *
 * dual-modality 接线:
 *   - 每条成功的 generate-* 调用之后,本路由 dispatchToSurface('wb-character',
 *     'reload', {charId, slug}) 通知前端 iframe panel 刷新视图
 *   - forgeax-cli (AI) 走 POST /api/bus/tools/<tool-id>?awaitAck=1 →
 *     bus.ts:dispatch 路由内部转 handler → 也跑同一个 dispatchToSurface 钩子
 *
 * Phase 6 (2026-05-21) 之后,wb-character-forge plugin 已删除,本路由是
 * /api/wb/character/* 的唯一入口。
 */

import { Hono } from 'hono';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  ForgeError,
  generatePortrait,
  generateSpriteSheet,
  getCharacter,
  getStatus,
  listCharacters,
  renameCharacter,
  upsertManifest,
  type HandlerCtx,
} from '@server-lib/character-forge';
import type { Context } from 'hono';
import { dispatchToSurface } from './bus';
import {
  getActiveCharacter,
  setActiveCharacter,
  type ActiveCharacterRole,
} from './lib/active-character';

export type CharacterRouterCtx = HandlerCtx;

// Surface id must match the React panel's registration id in
// packages/marketplace/plugins/wb-character-host/panel.tsx — 'wb-character.host'.
// The dispatched action ('reload') is the iframe-refresh trigger; payload
// carries which charId/slug changed so the panel can scope its reload.
const SURFACE_ID = 'wb-character.host';

function notifySurface(action: string, payload: Record<string, unknown>): void {
  try {
    dispatchToSurface(SURFACE_ID, action, payload);
  } catch {
    // Surface not registered (panel still mounting / closed) — silently drop;
    // panel re-fetches on its next focus. dual-modality is best-effort here.
  }
}

export function createCharacterRouter(ctx: CharacterRouterCtx): Hono {
  const r = new Hono();

  r.get('/status', (c) => c.json(getStatus(ctx)));

  r.post('/portrait', async (c) => {
    let body: Parameters<typeof generatePortrait>[1];
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    try {
      const result = await generatePortrait(ctx, body);
      notifySurface('reload', { charId: result.charId, slug: body.slug, kind: 'portrait' });
      return c.json(result);
    } catch (e) { return mapError(c, e); }
  });

  r.post('/sprite-sheet', async (c) => {
    let body: Parameters<typeof generateSpriteSheet>[1];
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    try {
      const result = await generateSpriteSheet(ctx, body);
      notifySurface('reload', { charId: result.charId, slug: body.slug, kind: 'sprite-sheet' });
      return c.json(result);
    } catch (e) { return mapError(c, e); }
  });

  // ── stubs for Phase 4 follow-up pipelines ─────────────────────────────
  // Each tool keeps a uniform 501 envelope so AI tool-callers (forgeax-cli)
  // can detect the gap and report it cleanly to the user; iframe panel can
  // also disable the corresponding button. Removed once the wb-character
  // submodule's dist/ + per-pipeline backend wiring lands.
  for (const stubId of [
    'pixel', 'spine', 'vfx', 'monster',
    'video', 'turnaround', 'vehicle',
  ] as const) {
    r.post(`/${stubId}`, async (c) => {
      try { await c.req.json(); } catch { /* tolerate missing body for stub */ }
      return c.json({
        error: 'not-implemented',
        message: `${stubId} pipeline scheduled for Phase 5 — see plans/bubbly-popping-brooks.md`,
        tool: `character:generate-${stubId}`,
      }, 501);
    });
  }

  r.get('/characters', async (c) => {
    try {
      return c.json(await listCharacters(ctx, c.req.query('slug') ?? ''));
    } catch (e) { return mapError(c, e); }
  });

  r.get('/characters/:charId', async (c) => {
    try {
      return c.json(await getCharacter(ctx, c.req.query('slug') ?? '', c.req.param('charId')));
    } catch (e) { return mapError(c, e); }
  });

  r.post('/characters/:charId/rename', async (c) => {
    let body: { slug?: string; name?: string };
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    try {
      const result = await renameCharacter(ctx, body.slug ?? '', c.req.param('charId'), body.name ?? '');
      notifySurface('reload', { charId: c.req.param('charId'), slug: body.slug, kind: 'rename' });
      return c.json(result);
    } catch (e) { return mapError(c, e); }
  });

  // /upsert-manifest —— 客户端管线(前端 /__ce-api__ 生图 + /upload-asset 落字节)
  // 产出最终设定图后,用这个把一份带 role 的 manifest.json 写盘,让角色被
  // listCharacters / 下游 wb-anim 发现。不在 server 端生图,只登记已上传的
  // portrait 相对路径 + role 元数据。
  // Body: { slug, charId, name?, role?, portraitFront?, portrait?, promptText? }
  r.post('/upsert-manifest', async (c) => {
    let body: Parameters<typeof upsertManifest>[1];
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    try {
      const result = await upsertManifest(ctx, body);
      notifySurface('reload', { charId: result.charId, slug: body.slug, kind: 'manifest' });
      return c.json(result);
    } catch (e) { return mapError(c, e); }
  });

  // ── active-character pointer ──────────────────────────────────────────
  // The cross-workbench handoff "pointer" — which character the user most
  // recently produced and wants downstream workbenches (anim/skill/reel) to
  // pick up. Persisted as .forgeax/games/<slug>/active-character.json so the
  // handoff survives reloads and is visible to AI/tooling (replaces the old
  // transient localStorage 'forgeax:anim-handoff' key as the source of truth).
  //
  // GET  /active-character?slug=<slug>  → { charId, role } | { charId: null }
  // POST /active-character { slug, charId, role? }
  r.get('/active-character', (c) => {
    const slug = c.req.query('slug') ?? '';
    const cur = getActiveCharacter(ctx.projectRoot, slug);
    return c.json(cur ?? { charId: null, role: null });
  });

  r.post('/active-character', async (c) => {
    let body: { slug?: string; charId?: string; role?: ActiveCharacterRole };
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    const slug = body.slug ?? '';
    const charId = body.charId ?? '';
    if (!slug || !charId) {
      return c.json({ error: 'missing-fields', message: 'slug, charId required' }, 400);
    }
    setActiveCharacter(ctx.projectRoot, slug, charId, body.role ?? 'hero');
    notifySurface('reload', { charId, slug, kind: 'active-character' });
    return c.json({ ok: true, charId, role: body.role ?? 'hero' });
  });

  // /asset —— raw byte stream for <img src> + AI fetch. Path must resolve under
  // <projectRoot>/.forgeax/games/<slug>/characters/ so a confused caller can't
  // pull arbitrary files through us. (Duplicate of wb-character-forge.ts's
  // implementation — kept here so the new route is self-contained for Phase 6.)
  r.get('/asset', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = safeAssetPath(ctx.projectRoot, rel);
    if (!abs) return c.json({ error: 'path outside character asset whitelist' }, 400);
    if (!existsSync(abs)) return c.json({ error: 'not-found' }, 404);
    const bytes = await readFile(abs);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': guessMime(abs), 'cache-control': 'no-cache' },
    });
  });

  // /upload-asset —— write client-generated bytes (concept image, turnaround,
  // sprite sheet, vehicle render, skill vfx, reel frame, …) to disk under the
  // per-game asset whitelist.  Pixel/vehicle pipelines run image generation
  // client-side via /__ce-api__ shim so the bytes never touch the existing
  // generatePortrait/generateSpriteSheet handlers; this is the catch-all write
  // path for "落盘到对应项目的文件夹里".
  //
  // Body: { slug, charId, rel, base64, mime?, module? }
  //   - `module` (default 'characters') selects the per-game subtree. For the
  //     character pipeline assets land at
  //       .forgeax/games/<slug>/characters/<charId>/<rel>
  //     For other workbenches (skill/reel) pass module='skills'|'reel' to land at
  //       .forgeax/games/<slug>/<module>/<charId>/<rel>
  //     so every workbench shares ONE validated write path under the game dir.
  //   - `rel` e.g. "pixel/turnaround.png", "concepts/0.png", "fire-slash/vfx.png".
  //   - `base64` may be bare base64 or a full "data:<mime>;base64,…" data URL.
  r.post('/upload-asset', async (c) => {
    let body: { slug?: string; charId?: string; rel?: string; base64?: string; mime?: string; module?: string };
    try { body = await c.req.json(); } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    const slug = body.slug ?? '';
    const charId = body.charId ?? '';
    const rel = body.rel ?? '';
    const raw = body.base64 ?? '';
    const moduleSeg = body.module ?? 'characters';
    if (!slug || !charId || !rel || !raw) {
      return c.json({ error: 'missing-fields', message: 'slug, charId, rel, base64 required' }, 400);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(charId)) {
      return c.json({ error: 'invalid-slug-or-charid' }, 400);
    }
    if (!/^[a-z0-9-]{1,40}$/i.test(moduleSeg)) {
      return c.json({ error: 'invalid-module' }, 400);
    }
    if (rel.includes('\0') || rel.includes('..') || isAbsolute(rel)) {
      return c.json({ error: 'invalid-rel' }, 400);
    }
    const fullRel = `.forgeax/games/${slug}/${moduleSeg}/${charId}/${rel}`;
    const abs = safeAssetPath(ctx.projectRoot, fullRel);
    if (!abs) return c.json({ error: 'path outside asset whitelist' }, 400);
    const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); }
    catch { return c.json({ error: 'invalid-base64' }, 400); }
    if (bytes.length === 0) return c.json({ error: 'empty-payload' }, 400);
    if (bytes.length > 32 * 1024 * 1024) return c.json({ error: 'payload-too-large' }, 413);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
    } catch (e) {
      return c.json({ error: 'write-failed', message: (e as Error).message.slice(0, 500) }, 500);
    }
    notifySurface('reload', { charId, slug, kind: 'asset', rel, module: moduleSeg });
    return c.json({
      ok: true,
      path: friendly(abs, ctx.projectRoot),
      url: `/api/wb/character/asset?path=${encodeURIComponent(fullRel)}`,
      bytes: bytes.length,
    });
  });

  return r;
}

function friendly(abs: string, projectRoot: string): string {
  const r = relative(projectRoot, abs);
  return r.startsWith('..') ? abs : r;
}

function mapError(c: Context, e: unknown): Response {
  if (e instanceof ForgeError) {
    return c.json({ error: e.code, message: e.message }, e.status as 400);
  }
  const msg = (e as Error)?.message ?? String(e);
  console.warn('[wb-character]', msg);
  return c.json({ error: 'internal-error', message: msg.slice(0, 500) }, 500);
}

function safeAssetPath(root: string, rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null;
  if (isAbsolute(rel)) return null;
  if (rel.includes('\0') || rel.includes('..')) return null;
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r.startsWith('..') || isAbsolute(r)) return null;
  const segs = r.split(/[/\\]/);
  // Whitelist: .forgeax/games/<slug>/<module>/... where <module> is one of the
  // known per-game asset roots. This is the shared "走文件" surface — every
  // workbench (character/anim/skill/reel/narrative) reads & writes its own
  // subtree under the SAME game project dir, so cross-module handoff is just
  // "write a file here, read a file there".
  const ALLOWED_MODULES = new Set([
    'characters', 'skills', 'reel', 'narrative', 'lowpoly-characters', 'public', 'wb-scene',
  ]);
  if (segs[0] !== '.forgeax' || segs[1] !== 'games' || !ALLOWED_MODULES.has(segs[3])) return null;
  return abs;
}

function guessMime(p: string): string {
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
