import { describe, expect, test } from 'bun:test';
import { createGenerativeVisualAccessPolicy } from './access-policy';

function request(origin: string, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:18900/api/generative-visuals/reactor/tokens', {
    headers: { origin, ...headers },
  });
}

describe('generative visual access policy', () => {
  test('allows local Studio and Tauri origins without a remote allowlist', () => {
    const policy = createGenerativeVisualAccessPolicy();

    expect(policy.authorize(request('https://localhost:18920'), '127.0.0.1')).toEqual({ ok: true });
    expect(policy.authorize(request('http://tauri.localhost'), '127.0.0.1')).toEqual({ ok: true });
  });

  test('fails closed when the server cannot establish connection provenance', () => {
    const policy = createGenerativeVisualAccessPolicy();

    expect(policy.authorize(request('https://localhost:18920'))).toEqual({
      ok: false,
      status: 403,
      error: 'connection provenance required',
    });
  });

  test('rejects remote origins by default', () => {
    const policy = createGenerativeVisualAccessPolicy();

    expect(policy.authorize(request('http://192.168.1.20:18920'), '192.168.1.20')).toEqual({
      ok: false,
      status: 403,
      error: 'local Studio origin required',
    });
  });

  test('allows an explicitly configured remote Studio origin', () => {
    const policy = createGenerativeVisualAccessPolicy({
      allowedOrigins: ['http://192.168.1.20:18920'],
    });

    expect(policy.authorize(request('http://192.168.1.20:18920'), '192.168.1.20')).toEqual({
      ok: true,
    });
  });

  test('ignores spoofed forwarded addresses unless a trusted proxy is enabled', () => {
    const policy = createGenerativeVisualAccessPolicy();
    const spoofed = request('https://localhost:18920', {
      'x-forwarded-for': '127.0.0.1',
    });

    expect(policy.authorize(spoofed, '192.168.1.20')).toMatchObject({
      ok: false,
      error: 'local Studio connection required',
    });
    expect(policy.clientKey(spoofed, '192.168.1.20')).toBe(
      policy.clientKey(request('https://localhost:18920', {
        'x-forwarded-for': '10.0.0.8',
      }), '192.168.1.20'),
    );
  });

  test('uses forwarded address only behind an explicitly trusted proxy', () => {
    const policy = createGenerativeVisualAccessPolicy({
      trustedProxy: true,
      trustedProxyAddresses: ['10.0.0.1'],
    });

    expect(policy.authorize(request('https://localhost:18920', {
      'x-forwarded-for': '127.0.0.1, 10.0.0.2',
    }), '10.0.0.1')).toEqual({ ok: true });
    expect(policy.clientKey(request('https://localhost:18920', {
      'x-forwarded-for': '10.0.0.2',
    }), '10.0.0.1')).not.toBe(
      policy.clientKey(request('https://localhost:18920', {
        'x-forwarded-for': '10.0.0.3',
      }), '10.0.0.1'),
    );
  });
});
