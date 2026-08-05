import { expect, test } from 'bun:test';
import { createPlaywrightCarrierHost, resolveCarrierHeadless } from '../src/runtime-carrier/playwright-host';
import { createRuntimeCarrierSupervisor } from '../src/runtime-carrier/supervisor';

const scope = { projectId: 'project-smoke', gameId: 'game-smoke' };

test('managed carrier stays headless unless diagnostics explicitly opt out', () => {
  expect(resolveCarrierHeadless(undefined, {})).toBe(true);
  expect(resolveCarrierHeadless(undefined, { FORGEAX_CARRIER_HEADLESS: '1' })).toBe(true);
  expect(resolveCarrierHeadless(undefined, { FORGEAX_CARRIER_HEADLESS: '0' })).toBe(false);
  expect(resolveCarrierHeadless(false, { FORGEAX_CARRIER_HEADLESS: '1' })).toBe(false);
});

test('headless host preserves current surface identity across reveal', async () => {
  const html = `<!doctype html><canvas id="canvas-smoke"></canvas><script>
    const params = new URLSearchParams(location.search);
    const runtimeId = params.get('runtimeId');
    const challengeResponse = params.get('ownershipChallenge');
    const scope = { projectId: 'project-smoke', gameId: 'game-smoke' };
    let sentinel = 0;
    const payload = () => ({
      version: 1, runtimeId, challengeResponse, scope, pageNonce: 'page-smoke',
      pageIdentity: location.origin + location.pathname, canvasIdentity: 'canvas-smoke',
      rendererIdentity: 'renderer-smoke', rendererGeneration: 1, sentinel: sentinel++, liveness: 'alive',
      renderReadiness: 'ready', failure: null,
    });
    window.__forgeax_carrier_health = payload();
    setInterval(() => { window.__forgeax_carrier_health = payload(); }, 100);
  </script>`;
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  const supervisor = createRuntimeCarrierSupervisor({
    host: createPlaywrightCarrierHost({
      baseUrl: `http://127.0.0.1:${server.port}`,
      timeoutMs: 10_000,
      headless: true,
    }),
  });

  try {
    const ensured = await supervisor.ensure(scope);
    expect(ensured).toMatchObject({ ok: true, lifecycle: 'starting' });
    if (!ensured.ok) throw new Error('headless carrier did not start');
    let running = await supervisor.status(ensured.runtimeId);
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline && running.ok && running.lifecycle === 'starting') {
      await Bun.sleep(50);
      running = await supervisor.status(ensured.runtimeId);
    }
    expect(running).toMatchObject({ ok: true, lifecycle: 'running', renderReadiness: 'ready' });
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
