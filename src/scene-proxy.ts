import type { HonoRequest } from 'hono';

export async function sceneProxyRequest(req: HonoRequest, origin: string): Promise<Request> {
  const url = new URL(req.url);
  // Hono middleware may already have consumed raw.body; use its cached reader.
  const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined;
  const headers = new Headers(req.raw.headers);
  for (const header of ['host', 'content-length', 'transfer-encoding', 'connection']) headers.delete(header);
  return new Request(`${origin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body,
  });
}

export function sceneProxyWsUrl(pathname: string, search: string, port: string): string | undefined {
  if (!['/ws/render', '/ws/editor', '/ws/log'].includes(pathname)) return undefined;
  return `ws://127.0.0.1:${port}${pathname === '/ws/render' ? '/ws' : pathname}${search}`;
}
