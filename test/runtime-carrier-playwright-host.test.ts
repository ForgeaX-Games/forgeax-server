import { expect, test } from 'bun:test';
import { createPlaywrightCarrierHost } from '../src/runtime-carrier/playwright-host';
import { createRuntimeCarrierSupervisor } from '../src/runtime-carrier/supervisor';

const scope = { projectId: 'project-smoke', gameId: 'game-smoke' };

test('headed host reveals the original page while preserving current surface identity', async () => {
  const html = `<!doctype html><canvas id="canvas-smoke"></canvas><script>
    const scope = { projectId: 'project-smoke', gameId: 'game-smoke' };
    let sentinel = 0;
    const payload = () => ({
      version: 1, runtimeId: 'runtime-smoke', scope, pageNonce: 'page-smoke',
      pageIdentity: location.origin + location.pathname, canvasIdentity: 'canvas-smoke',
      rendererIdentity: 'renderer-smoke', sentinel: sentinel++, liveness: 'alive',
      renderReadiness: 'ready', failure: null,
    });
    window.parent.postMessage({ type: 'VAG_CARRIER_HANDSHAKE', payload: payload() }, '*');
    setInterval(() => window.parent.postMessage({ type: 'VAG_CARRIER_HEARTBEAT', payload: payload() }, '*'), 100);
  </script>`;
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  const supervisor = createRuntimeCarrierSupervisor({
    host: createPlaywrightCarrierHost({ baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 10_000 }),
  });

  try {
    const ensured = await supervisor.ensure(scope);
    expect(ensured).toMatchObject({ ok: true, lifecycle: 'running', renderReadiness: 'ready' });
    if (!ensured.ok) throw new Error('headed carrier did not start');
    await Bun.sleep(250);
    const beforeReveal = await supervisor.status(ensured.runtimeId);
    const revealed = await supervisor.reveal(ensured.runtimeId);
    await Bun.sleep(150);
    const afterReveal = await supervisor.status(ensured.runtimeId);
    expect(beforeReveal).toMatchObject({ ok: true, pageNonce: 'page-smoke', canvasIdentity: 'canvas-smoke', rendererIdentity: 'renderer-smoke' });
    expect(revealed).toMatchObject({ ok: true, runtimeId: ensured.runtimeId });
    expect(afterReveal).toMatchObject({ ok: true, pageNonce: 'page-smoke', canvasIdentity: 'canvas-smoke', rendererIdentity: 'renderer-smoke' });
    if (beforeReveal.ok && afterReveal.ok) expect(afterReveal.heartbeat?.sentinel).toBeGreaterThan(beforeReveal.heartbeat?.sentinel ?? -1);
    expect(await supervisor.stop(ensured.runtimeId)).toMatchObject({ ok: true, lifecycle: 'stopped' });
  } finally {
    server.stop();
    await supervisor.shutdown();
  }
});
