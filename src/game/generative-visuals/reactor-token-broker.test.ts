import { describe, expect, test } from 'bun:test';
import { createGenerativeVisualAccessPolicy } from './access-policy';
import { createReactorTokenRouter, ReactorTokenBroker } from './reactor-token-broker';

const testAccessPolicy = () => createGenerativeVisualAccessPolicy({
  requireConnectionProvenance: false,
});

describe('ReactorTokenBroker', () => {
  test('caches private JWTs while enforcing and releasing session leases', async () => {
    let requests = 0;
    const broker = new ReactorTokenBroker({
      apiKey: 'rk_test',
      maxSessionsPerClient: 2,
      now: () => 1_000_000,
      fetch: (async () => {
        requests += 1;
        return Response.json({ jwt: 'header.payload.signature', expires_at: 2_000 });
      }) as unknown as typeof fetch,
    });

    const first = await broker.issue('studio|127.0.0.1', 'panel-one');
    expect(first).toMatchObject({ ok: true, jwt: 'header.payload.signature' });
    const repeated = await broker.issue('studio|127.0.0.1', 'panel-one');
    expect(repeated).toMatchObject({ ok: true, leaseId: (first as { leaseId: string }).leaseId });

    const second = await broker.issue('studio|127.0.0.1', 'panel-two');
    expect(second).toMatchObject({ ok: true, jwt: 'header.payload.signature' });
    const blocked = await broker.issue('studio|127.0.0.1', 'panel-three');
    expect(blocked).toEqual({
      ok: false,
      status: 429,
      error: 'generative visual session limit reached',
    });
    expect(requests).toBe(1);

    expect(broker.release('studio|127.0.0.1', (first as { leaseId: string }).leaseId)).toBe(true);
    expect(await broker.issue('studio|127.0.0.1', 'panel-three')).toMatchObject({ ok: true });
  });

  test('only mints via same-origin POST requests', async () => {
    const router = createReactorTokenRouter({
      apiKey: 'rk_test',
      accessPolicy: testAccessPolicy(),
      fetch: (async () => Response.json({
        jwt: 'header.payload.signature',
        expires_at: Math.floor(Date.now() / 1_000) + 600,
      })) as unknown as typeof fetch,
    });
    const body = JSON.stringify({ session: 'panel_session' });

    const missingOrigin = await router.request('http://localhost/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(missingOrigin.status).toBe(403);

    const accepted = await router.request('http://localhost/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ jwt: 'header.payload.signature' });
  });

  test('returns the configured coordinator URL for browser model construction', async () => {
    const router = createReactorTokenRouter({
      apiKey: 'rk_test',
      accessPolicy: testAccessPolicy(),
      coordinatorUrl: 'https://reactor.internal.test/',
      fetch: (async () => Response.json({
        jwt: 'header.payload.signature',
        expires_at: Math.floor(Date.now() / 1_000) + 600,
      })) as unknown as typeof fetch,
    });

    const response = await router.request('http://localhost/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ session: 'panel_session' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jwt: 'header.payload.signature',
      coordinatorUrl: 'https://reactor.internal.test',
    });
  });

  test('rejects remote token requests before contacting Reactor', async () => {
    let requests = 0;
    const router = createReactorTokenRouter({
      apiKey: 'rk_test',
      fetch: (async () => {
        requests += 1;
        return Response.json({ jwt: 'must-not-be-issued' });
      }) as unknown as typeof fetch,
    });

    const response = await router.request('http://localhost/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://192.168.1.20:18920',
        'x-forwarded-for': '127.0.0.1',
      },
      body: JSON.stringify({ session: 'remote-session' }),
    });

    expect(response.status).toBe(403);
    expect(requests).toBe(0);
  });
});
