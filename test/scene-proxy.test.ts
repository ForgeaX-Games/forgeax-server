import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { sceneProxyRequest, sceneProxyWsUrl } from '../src/scene-proxy';

describe('scene host proxy', () => {
  test('forwards JSON cached by upstream middleware with recomputed framing', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { await c.req.json(); await next(); });
    app.post('/api/v1/*', async (c) => {
      const request = await sceneProxyRequest(c.req, 'http://127.0.0.1:9557');
      expect(request.url).toBe('http://127.0.0.1:9557/api/v1/projects/main/scene-script/validate?check=1');
      expect(request.headers.has('content-length')).toBe(false);
      expect(request.headers.has('host')).toBe(false);
      expect(await request.json()).toEqual({ source: 'scene' });
      return c.json({ ok: true });
    });
    const response = await app.request('/api/v1/projects/main/scene-script/validate?check=1', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '18', host: 'localhost:48900' },
      body: JSON.stringify({ source: 'scene' }),
    });
    expect(response.status).toBe(200);
  });

  test('preserves GET and HEAD without attempting body consumption', async () => {
    const app = new Hono();
    app.all('*', async (c) => {
      const request = await sceneProxyRequest(c.req, 'http://127.0.0.1:9557');
      expect(request.body).toBeNull();
      return new Response(null, { status: 204 });
    });
    for (const method of ['GET', 'HEAD']) expect((await app.request('/api/v1/health', { method })).status).toBe(204);
  });

  test('routes the embedded renderer to the scene socket, leaving the host socket alone', () => {
    expect(sceneProxyWsUrl('/ws/render', '?project=main', '9557')).toBe('ws://127.0.0.1:9557/ws?project=main');
    expect(sceneProxyWsUrl('/ws', '', '9557')).toBeUndefined();
    expect(sceneProxyWsUrl('/ws/editor', '', '9557')).toBe('ws://127.0.0.1:9557/ws/editor');
  });
});
