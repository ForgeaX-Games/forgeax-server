import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  createRemoteKinoBinding,
  forgeaxKinoScope,
} from '../../src/workbench/remote-kino-binding';

const namespaceSecret = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const encodedSecret = Buffer.from(namespaceSecret).toString('base64url');

function environment(overrides: Record<string, string> = {}) {
  return {
    FORGEAX_KINO_BASE_URL: 'https://kino.example',
    FORGEAX_KINO_GATEWAY_TOKEN: 'gateway-secret-token',
    FORGEAX_KINO_NAMESPACE_SECRET: encodedSecret,
    FORGEAX_KINO_OUTPUT_ORIGINS: 'https://cdn.example',
    ...overrides,
  };
}

describe('ForgeaX remote Kino binding', () => {
  test('uses the exact installation/game HMAC scope formula', async () => {
    const binding = await createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      installationId: 'installation-a',
      env: environment(),
      fetch: (async () => Response.json({ code: 0, data: {} })) as unknown as typeof fetch,
    });

    const expected = `fx_${createHmac('sha256', namespaceSecret)
      .update('installation-a')
      .update('\0')
      .update('game-a')
      .digest('hex')}`;
    expect(await binding.scope('game-a')).toBe(expected);
    expect(await binding.scope('game-b')).not.toBe(expected);
    expect(await binding.scope('game-a')).not.toContain('game-a');
    expect(await forgeaxKinoScope(namespaceSecret, 'installation-b', 'game-a'))
      .not.toBe(expected);
  });

  test('isolates different installations and never lets the caller override credentials', async () => {
    let request: Request | undefined;
    const binding = await createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      installationId: 'installation-a',
      env: environment(),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        request = new Request(input as any, init);
        return Response.json({ code: 0, data: {} });
      }) as unknown as typeof fetch,
    });
    const second = await createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      installationId: 'installation-b',
      env: environment(),
      fetch: (async () => Response.json({ code: 0, data: {} })) as unknown as typeof fetch,
    });

    expect(await binding.scope('game-a')).not.toBe(await second.scope('game-a'));
    await binding.request({
      gameId: 'game-a',
      path: '/generations',
      method: 'POST',
      headers: {
        'X-Gateway-Token': 'attacker-token',
        authorization: 'attacker-auth',
      },
      json: { prompt: 'hello' },
    });
    expect(request?.headers.get('x-gateway-token')).toBe('gateway-secret-token');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(request?.url).toBe('https://kino.example/api/v1/kino/generations');
  });

  test('fails closed for missing or weak configuration without leaking the token', async () => {
    await expect(createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      env: environment({ FORGEAX_KINO_GATEWAY_TOKEN: '' }),
    })).rejects.toThrow('FORGEAX_KINO_GATEWAY_TOKEN');

    await expect(createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      env: environment({ FORGEAX_KINO_NAMESPACE_SECRET: 'short-secret' }),
    })).rejects.toThrow('at least 32 bytes');

    await expect(createRemoteKinoBinding({
      projectRoot: '/tmp/forgeax-project',
      env: environment({ FORGEAX_KINO_OUTPUT_ORIGINS: '' }),
    })).rejects.toThrow('FORGEAX_KINO_OUTPUT_ORIGINS');
  });
});
