// Regression: ce-api-shim media routes go through the orchestrator
// MediaGateways capability face (A3 / D-2), not per-vendor imports.
//
// The point of these assertions is the *routing seam*, not a live provider
// call: every media endpoint must resolve through `createMediaGateways(env)`
// and keep the pre-refactor `{ success, ... }` envelope. They are deterministic
// because they exercise the validation / capability-probe paths that never hit
// the network.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createCeApiShimRouter } from './ce-api-shim';

// The audio/video vendor predicates read process.env directly (unchanged by the
// refactor). Snapshot + clear the relevant keys so "not configured" is a stable
// fact for this test process regardless of the ambient shell env.
const VENDOR_ENV_KEYS = [
  'LITELLM_PROXY_BASE_URL',
  'LITELLM_PROXY_KEY',
  'MINIMAX_API_KEY',
  'DOUBAO_TTS_KEY',
  'DOUBAO_TTS_APP_ID',
  'MINIMAX_MUSIC_KEY',
  'ELEVENLABS_API_KEY',
  'ARK_VIDEO_KEY',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of VENDOR_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(() => {
  for (const k of VENDOR_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const makeRouter = () => createCeApiShimRouter({ projectRoot: '/tmp/a3-ce-api-shim-test', env: {} });

describe('ce-api-shim media routes via MediaGateways', () => {
  test('audio-generation-status reflects the MediaGateways capability shape', async () => {
    const router = makeRouter();
    const res = await router.request('http://localhost/audio-generation-status');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      capabilities: {
        tts: { configured: boolean; providers: string[] };
        music: { configured: boolean; providers: string[] };
        sfx: { configured: boolean; providers: string[] };
      };
    };
    expect(json.success).toBe(true);
    // The shape is produced by gateways.capabilities(): each media kind carries
    // a `configured` boolean + a `providers` label array.
    for (const kind of ['tts', 'music', 'sfx'] as const) {
      expect(typeof json.capabilities[kind].configured).toBe('boolean');
      expect(Array.isArray(json.capabilities[kind].providers)).toBe(true);
    }
    // With every vendor key cleared, all three collapse to not-configured — the
    // capability face's not-configured verdict flows through unchanged.
    expect(json.capabilities.tts.configured).toBe(false);
    expect(json.capabilities.music.configured).toBe(false);
    expect(json.capabilities.sfx.configured).toBe(false);
  });

  test('reel-tts surfaces the not-configured envelope through gateways.capabilities()', async () => {
    const router = makeRouter();
    const res = await router.request('http://localhost/reel-tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', voice: 'v1' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; error?: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('TTS');
  });

  test('reel-music surfaces the not-configured envelope through gateways.capabilities()', async () => {
    const router = makeRouter();
    const res = await router.request('http://localhost/reel-music', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'calm bgm' }),
    });
    const json = (await res.json()) as { success: boolean; error?: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('BGM');
  });

  test('generate-video surfaces the not-configured envelope through gateways.capabilities()', async () => {
    const router = makeRouter();
    const res = await router.request('http://localhost/generate-video', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a short clip' }),
    });
    const json = (await res.json()) as { success: boolean; error?: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('ARK_VIDEO_KEY');
  });

  test('media routes stay wired: invalid JSON keeps the shim envelope', async () => {
    const router = makeRouter();
    const res = await router.request('http://localhost/reel-sfx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const json = (await res.json()) as { success: boolean; error?: string };
    expect(json.success).toBe(false);
    // reel-sfx checks capability before body parse, so with keys cleared the
    // not-configured envelope wins; either way the route is reachable and
    // returns the shim envelope (never an HTTP error).
    expect(typeof json.error).toBe('string');
  });
});
