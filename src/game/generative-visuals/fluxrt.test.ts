import { afterEach, describe, expect, test } from 'bun:test';
import { createGenerativeVisualAccessPolicy } from './access-policy';
import { createFluxRtRouter, getFluxRtWsUpstreamUrl } from './fluxrt';

const originalBaseUrl = process.env.FLUXRT_BASE_URL;
const originalFluxRtKey = process.env.FLUXRT_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.FLUXRT_BASE_URL;
  else process.env.FLUXRT_BASE_URL = originalBaseUrl;
  if (originalFluxRtKey === undefined) delete process.env.FLUXRT_API_KEY;
  else process.env.FLUXRT_API_KEY = originalFluxRtKey;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
});

describe('FluxRT server boundary', () => {
  test('does not reuse the Anthropic key for the render relay', () => {
    process.env.FLUXRT_BASE_URL = 'https://flux.example.test';
    delete process.env.FLUXRT_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-only';

    expect(getFluxRtWsUpstreamUrl()).toBeNull();
  });

  test('uses the dedicated FluxRT key when configured', () => {
    process.env.FLUXRT_BASE_URL = 'https://flux.example.test/';
    process.env.FLUXRT_API_KEY = 'flux-only';
    delete process.env.ANTHROPIC_API_KEY;

    expect(getFluxRtWsUpstreamUrl()).toBe('wss://flux.example.test/ws?key=flux-only');
  });

  test('rejects a remote predict request before contacting the upstream', async () => {
    const router = createFluxRtRouter({
      accessPolicy: createGenerativeVisualAccessPolicy(),
    });

    const response = await router.request('http://localhost/predict', {
      method: 'POST',
      headers: {
        origin: 'http://192.168.1.20:18920',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ base64_image: 'not-sent-upstream' }),
    });

    expect(response.status).toBe(403);
  });
});
