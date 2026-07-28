import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createRuntimeCarrierSupervisor,
  type CarrierHost,
  type CarrierHostHandle,
  type RuntimeScope,
} from '../src/runtime-carrier/supervisor';
import { mountRuntimeCarrierApi } from '../src/runtime-carrier/api';

const scope: RuntimeScope = { projectId: 'project-a', gameId: 'game-a' };

const host: CarrierHost = {
  supportsReveal: true,
  async start(input): Promise<CarrierHostHandle> {
    return {
      runtimeId: input.runtimeId,
      challengeResponse: input.ownerToken,
      confirmedScope: input.scope,
      pageNonce: 'page-a',
      pageIdentity: 'http://localhost:18920/preview/',
      canvasIdentity: 'canvas-a',
      rendererIdentity: 'renderer-a',
      sentinel: 0,
      reveal: async () => {},
      stop: async () => {},
    };
  },
};

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('server surface exposes only ensure, status, reveal, and stop projections', async () => {
  const app = new Hono();
  const supervisor = createRuntimeCarrierSupervisor({ host });
  mountRuntimeCarrierApi(app, supervisor);

  const ensuredResponse = await app.request('/api/runtime-carrier/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  const ensured = await json(ensuredResponse);
  expect(ensuredResponse.status).toBe(200);
  expect(ensured).toMatchObject({ ok: true, action: 'ensure', lifecycle: 'starting' });
  const runtimeId = ensured.runtimeId as string;

  for (let i = 0; i < 20; i++) {
    const status = await app.request(`/api/runtime-carrier/status/${runtimeId}`);
    const body = await json(status);
    if (body.lifecycle === 'running') break;
    await Bun.sleep(10);
  }

  const statusResponse = await app.request(`/api/runtime-carrier/status/${runtimeId}`);
  expect(statusResponse.status).toBe(200);
  expect(await json(statusResponse)).toMatchObject({ ok: true, action: 'status', runtimeId });

  const revealResponse = await app.request(`/api/runtime-carrier/reveal/${runtimeId}`, { method: 'POST' });
  expect(revealResponse.status).toBe(200);
  expect(await json(revealResponse)).toMatchObject({ ok: true, action: 'reveal', runtimeId });

  const stopResponse = await app.request(`/api/runtime-carrier/stop/${runtimeId}`, { method: 'POST' });
  expect(stopResponse.status).toBe(200);
  expect(await json(stopResponse)).toMatchObject({ ok: true, action: 'stop', lifecycle: 'stopped', runtimeId });
});

test('server surface returns structured errors and has no W1-L2 actions', async () => {
  const app = new Hono();
  mountRuntimeCarrierApi(app, createRuntimeCarrierSupervisor({ host }));

  const response = await app.request('/api/runtime-carrier/status/unknown-runtime');
  expect(response.status).toBe(404);
  expect(await json(response)).toMatchObject({ ok: false, action: 'status', error: { code: 'UNKNOWN_RUNTIME' } });

  for (const action of ['play', 'control', 'input', 'query', 'capture', 'restart']) {
    const unsupported = await app.request(`/api/runtime-carrier/${action}`, { method: 'POST' });
    expect(unsupported.status).toBe(404);
  }
});
