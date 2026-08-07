/**
 * /api/wb/bgm —— residual host route for the Music & BGM plugin.
 *
 * wb-bgm's LOGIC (library search / attach / manifest / raw passthrough) has
 * MOVED into the marketplace plugin @forgeax-extension/wb-bgm (server/tool-handlers.ts
 * + src/core.ts), reachable via the Host ToolRegistry (/api/tools/call) for both
 * humans (SPA, caller.kind='user') and AI (native kit forward + CLI MCP).
 *
 * Only ONE route remains here: `/cos-proxy`, a GENERIC binary stream + Range +
 * CORS shield used by the SPA's <audio> preview and zip download. It carries no
 * bgm business logic or credentials (it just proxies an https URL), so it stays
 * host-side rather than forcing the plugin to run a standalone HTTP backend.
 */

import { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

interface CustomAudioIndexRow {
  assetId: string;
  relativePath: string;
  mimeType: string;
}

interface CustomAudioIndex {
  schemaVersion: string;
  assets: CustomAudioIndexRow[];
}

export interface BgmRouterOptions {
  projectRoot: string;
}

const CUSTOM_AUDIO_MIMES = new Set(['audio/ogg', 'audio/mpeg', 'audio/wav']);

function isBeneath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function parseByteRange(value: string | undefined, size: number):
  | { start: number; end: number }
  | 'invalid'
  | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return 'invalid';
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size) return 'invalid';
  return { start, end };
}

export function createBgmRouter(options: BgmRouterOptions): Hono {
  const r = new Hono();

  r.get('/custom/:assetId', async (c) => {
    let assetId: string;
    try {
      assetId = decodeURIComponent(c.req.param('assetId'));
    } catch {
      return c.text('bad asset id', 400);
    }
    if (!/^custom:(bgm|sfx):sha256:[a-f0-9]{64}$/.test(assetId)) {
      return c.text('not found', 404);
    }
    const root = resolve(options.projectRoot, '.forgeax', 'assets', 'audio-custom');
    let index: CustomAudioIndex;
    try {
      index = JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')) as CustomAudioIndex;
    } catch {
      return c.text('not found', 404);
    }
    if (index.schemaVersion !== 'forgeax-custom-audio-library/1' || !Array.isArray(index.assets)) {
      return c.text('not found', 404);
    }
    const asset = index.assets.find((candidate) => candidate.assetId === assetId);
    if (!asset || !CUSTOM_AUDIO_MIMES.has(asset.mimeType)) return c.text('not found', 404);
    const candidate = resolve(root, asset.relativePath);
    if (!isBeneath(root, candidate)) return c.text('not found', 404);
    let physicalRoot: string;
    let physicalFile: string;
    try {
      [physicalRoot, physicalFile] = await Promise.all([realpath(root), realpath(candidate)]);
    } catch {
      return c.text('not found', 404);
    }
    if (!isBeneath(physicalRoot, physicalFile)) return c.text('not found', 404);
    const file = Bun.file(physicalFile);
    if (!(await file.exists())) return c.text('not found', 404);
    const range = parseByteRange(c.req.header('range'), file.size);
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': asset.mimeType,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (range === 'invalid') {
      headers.set('Content-Range', `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const length = range.end - range.start + 1;
      headers.set('Content-Length', String(length));
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
    }
    headers.set('Content-Length', String(file.size));
    return new Response(file, { status: 200, headers });
  });

  // COS blob proxy (CORS shield). Forwards the client's Range header so
  // <audio>/<video> can learn the total duration (via Content-Range) and seek;
  // passes the upstream status (200 or 206) through instead of forcing 200.
  r.get('/cos-proxy', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'missing-url' }, 400);
    if (!/^https?:\/\//.test(url)) return c.json({ error: 'invalid-url' }, 400);
    const range = c.req.header('range');
    let resp: Response;
    try {
      resp = await fetch(url, range ? { headers: { Range: range } } : undefined);
    } catch (e) {
      return c.json({ error: 'upstream-failed', message: (e as Error).message }, 502);
    }
    if (!resp.ok && resp.status !== 206) return c.text(`upstream returned ${resp.status}`, resp.status as 502);
    const headers = new Headers();
    headers.set('content-type', resp.headers.get('content-type') || 'application/octet-stream');
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag'] as const) {
      const v = resp.headers.get(h);
      if (v) headers.set(h, v);
    }
    const acceptRanges = resp.headers.get('accept-ranges');
    if (acceptRanges) headers.set('accept-ranges', acceptRanges);
    else if (resp.status === 206 || resp.headers.get('content-range')) headers.set('accept-ranges', 'bytes');
    headers.set('access-control-allow-origin', '*');
    headers.set('cache-control', 'public, max-age=3600');
    return new Response(resp.body, { status: resp.status, headers });
  });

  return r;
}
