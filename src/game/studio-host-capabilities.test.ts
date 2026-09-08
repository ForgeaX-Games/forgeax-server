import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STUDIO_HOST_CAPABILITIES,
  resolveStudioHostCapabilities,
} from './studio-host-capabilities';

describe('Studio host capabilities', () => {
  test('fails closed when Studio did not explicitly configure the DEV relay', async () => {
    let called = false;
    const capabilities = await resolveStudioHostCapabilities({
      env: {},
      fetch: async () => {
        called = true;
        return new Response('{}');
      },
    });

    expect(capabilities).toEqual(DEFAULT_STUDIO_HOST_CAPABILITIES);
    expect(called).toBe(false);
  });

  test('requires a healthy loopback relay contract before exposing the capability', async () => {
    const calls: string[] = [];
    const capabilities = await resolveStudioHostCapabilities({
      env: { FORGEAX_EDITOR_RELAY_URL: 'http://127.0.0.1:25295/' },
      fetch: async (url) => {
        calls.push(url);
        return Response.json({ pageConnected: false });
      },
    });

    expect(calls).toEqual(['http://127.0.0.1:25295/health']);
    expect(capabilities).toEqual({
      editorRelay: {
        available: true,
        baseUrl: 'http://127.0.0.1:25295',
        reason: 'available',
      },
    });
  });

  test('rejects non-loopback, unreachable, and malformed health projections', async () => {
    await expect(resolveStudioHostCapabilities({
      env: { FORGEAX_EDITOR_RELAY_URL: 'https://relay.example.test:25295' },
    })).resolves.toEqual({ editorRelay: { available: false, reason: 'invalid-url' } });

    await expect(resolveStudioHostCapabilities({
      env: { FORGEAX_EDITOR_RELAY_URL: 'http://localhost:25295' },
      fetch: async () => new Response('', { status: 503 }),
    })).resolves.toEqual({
      editorRelay: { available: false, baseUrl: 'http://localhost:25295', reason: 'unhealthy' },
    });

    await expect(resolveStudioHostCapabilities({
      env: { FORGEAX_EDITOR_RELAY_URL: 'http://localhost:25295' },
      fetch: async () => Response.json({ status: 'ok' }),
    })).resolves.toEqual({
      editorRelay: { available: false, baseUrl: 'http://localhost:25295', reason: 'invalid-health' },
    });
  });
});
