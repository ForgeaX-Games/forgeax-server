import { describe, expect, test } from 'bun:test';
import { resolveLlmTestRequestSource } from '../src/game/llm-test-source';

function request(referer?: string, claimedSource = 'studio-ui', origin?: string): Request {
  return new Request('http://localhost:18900/api/llm/test', {
    headers: {
      ...(referer ? { referer } : {}),
      ...(origin ? { origin } : {}),
      'x-forgeax-request-source': claimedSource,
    },
  });
}

describe('resolveLlmTestRequestSource', () => {
  test('classifies preview and play routes as game runtime', () => {
    expect(resolveLlmTestRequestSource(request('http://localhost:18920/preview/host-games/demo/main.ts')))
      .toBe('game-runtime');
    expect(resolveLlmTestRequestSource(request(
      undefined,
      'studio-ui',
      'http://localhost:15173',
    ))).toBe('game-runtime');
    expect(resolveLlmTestRequestSource(request('http://localhost:18920/play/demo')))
      .toBe('game-runtime');
  });

  test('allows Studio routes and ignores a client source claim', () => {
    expect(resolveLlmTestRequestSource(request('http://localhost:18920/settings', 'game-runtime')))
      .toBe('studio-ui');
  });

  test('fails closed for malformed browser provenance', () => {
    expect(resolveLlmTestRequestSource(request('not a url'))).toBe('game-runtime');
    expect(resolveLlmTestRequestSource(request())).toBe('game-runtime');
  });
});
