import { describe, expect, it } from 'bun:test';
import { hostApiAllowedOrigins, hostApiOriginAllowed } from '../src/host-api-origin';

describe('Host API allowed origins', () => {
  it('derives loopback origins from the active Interface port', () => {
    expect([...hostApiAllowedOrigins({ FORGEAX_INTERFACE_PORT: '28920' })]).toEqual([
      'http://127.0.0.1:28920',
      'http://localhost:28920',
    ]);
  });

  it('includes one explicit public origin without widening its scope', () => {
    expect([
      ...hostApiAllowedOrigins({
        FORGEAX_INTERFACE_PORT: '28920',
        FORGEAX_INTERFACE_HTTPS: '1',
        FORGEAX_PUBLIC_ORIGIN: 'https://studio.example.test',
      }),
    ]).toEqual([
      'https://127.0.0.1:28920',
      'https://localhost:28920',
      'https://studio.example.test',
    ]);
  });

  it('allows HTTPS origins from exact hosts and leading-dot domains', () => {
    expect(hostApiOriginAllowed('https://studio.example.test', {
      FORGEAX_INTERFACE_ALLOWED_HOSTS: 'studio.example.test',
    })).toBe(true);
    expect(hostApiOriginAllowed('https://assets.example.com', {
      FORGEAX_INTERFACE_ALLOWED_HOSTS: 'assets.example.com',
    })).toBe(true);
    expect(hostApiOriginAllowed('https://assets.example.com', {
      FORGEAX_INTERFACE_ALLOWED_HOSTS: 'assets.example.com',
    })).toBe(true);
  });

  it('rejects insecure, suffix-confused, wildcard, and malformed remote origins', () => {
    const env = { FORGEAX_INTERFACE_ALLOWED_HOSTS: 'assets.example.com' };
    expect(hostApiOriginAllowed('http://assets.example.com', env)).toBe(false);
    expect(hostApiOriginAllowed('https://assets.example.com', env)).toBe(false);
    expect(hostApiOriginAllowed('https://attacker.example', {
      FORGEAX_INTERFACE_ALLOWED_HOSTS: 'true,*',
    })).toBe(false);
    expect(hostApiOriginAllowed('not-an-origin', env)).toBe(false);
  });

  it('rejects invalid ports and URL-shaped public paths', () => {
    expect(() => hostApiAllowedOrigins({ FORGEAX_INTERFACE_PORT: '0' })).toThrow();
    expect(() =>
      hostApiAllowedOrigins({ FORGEAX_PUBLIC_ORIGIN: 'https://studio.example.test/path' }),
    ).toThrow();
  });
});
