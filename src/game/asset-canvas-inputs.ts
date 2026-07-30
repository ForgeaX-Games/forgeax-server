import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Hono } from 'hono';

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SAFE_FILE_RE = /^[a-f0-9]{16}-[A-Za-z0-9._-]{1,100}$/;

export function createAssetCanvasInputsRouter(
  projectRoot: () => string,
): Hono {
  const router = new Hono();
  router.get('/:slug/:fileName', async (c) => {
    const slug = c.req.param('slug');
    const fileName = c.req.param('fileName');
    if (!SAFE_SLUG_RE.test(slug) || !SAFE_FILE_RE.test(fileName)) {
      return c.text('bad path', 400);
    }

    const root = realpathSync(projectRoot());
    const uploadDir = resolve(root, '.forgeax', 'games', slug, 'asset-canvas', 'uploads');
    if (!existsSync(uploadDir) || lstatSync(uploadDir).isSymbolicLink()) {
      return c.text('not found', 404);
    }
    const uploadReal = realpathSync(uploadDir);
    if (!isWithin(root, uploadReal)) return c.text('forbidden', 403);

    const file = resolve(uploadReal, fileName);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
      return c.text('not found', 404);
    }
    const fileReal = realpathSync(file);
    if (!isWithin(uploadReal, fileReal)) return c.text('forbidden', 403);

    const contentType = contentTypeFor(fileName);
    if (!contentType) return c.text('unsupported media type', 415);
    const body = Bun.file(fileReal);
    return new Response(body, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  return router;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function contentTypeFor(fileName: string): string | null {
  const extension = fileName.toLowerCase().split('.').at(-1);
  return ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    glb: 'model/gltf-binary',
    fbx: 'application/octet-stream',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',
  } as Record<string, string>)[extension ?? ''] ?? null;
}
