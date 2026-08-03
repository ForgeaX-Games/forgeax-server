import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRemoteKinoBinding } from '../../src/workbench/remote-kino-binding';

interface SmokeAsset {
  readonly id: string;
  readonly type: 'video';
  readonly contentType: 'video/mp4';
}

interface SmokeResult {
  readonly assets: readonly SmokeAsset[];
  readonly jobIdHash: string;
}

let realSubmitUsed = false;

function hashJobId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Opt-in smoke helper. It returns only Host-safe identifiers and media
 * metadata; provider task ids, service tokens, and signed output URLs never
 * leave this function.
 */
export async function generateOnce(input: {
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly idempotencyKey: string;
}): Promise<SmokeResult> {
  if (realSubmitUsed) throw new Error('real Kino smoke allows one submit per process');
  realSubmitUsed = true;
  const env = process.env;
  const baseUrl = env.FORGEAX_KINO_BASE_URL;
  const gatewayToken = env.FORGEAX_KINO_GATEWAY_TOKEN;
  const namespaceSecret = env.FORGEAX_KINO_NAMESPACE_SECRET;
  const outputOrigins = env.FORGEAX_KINO_OUTPUT_ORIGINS;
  const gameId = env.FORGEAX_KINO_GAME_ID ?? 'real-kino-smoke';
  if (!baseUrl || !gatewayToken || !namespaceSecret || !outputOrigins) {
    throw new Error('real Kino smoke requires ForgeaX Kino environment configuration');
  }
  const binding = await createRemoteKinoBinding({
    projectRoot: env.FORGEAX_PROJECT_ROOT ?? process.cwd(),
    env: {
      FORGEAX_KINO_BASE_URL: baseUrl,
      FORGEAX_KINO_GATEWAY_TOKEN: gatewayToken,
      FORGEAX_KINO_NAMESPACE_SECRET: namespaceSecret,
      FORGEAX_KINO_OUTPUT_ORIGINS: outputOrigins,
    },
  });
  const scope = await binding.scope(gameId);
  const submitted = await binding.request({
    gameId,
    path: '/generations',
    method: 'POST',
    json: {
      game_id: scope,
      media_type: 'video',
      model: 'seedance2',
      duration_sec: input.durationSeconds,
      content: [{ type: 'text', text: input.prompt }],
      idempotency_key: input.idempotencyKey,
    },
  });
  const data = JSON.parse(new TextDecoder().decode(submitted.body)) as {
    data?: { generation_id?: string; status?: string; resource?: { url?: string } };
  };
  const generationId = data.data?.generation_id;
  if (!generationId) throw new Error('Kino smoke response did not contain a generation id');

  let status = data.data?.status ?? 'polling';
  let outputUrl = data.data?.resource?.url;
  for (let attempt = 0; attempt < 120 && status !== 'succeeded'; attempt += 1) {
    if (status === 'failed' || status === 'cancelled') throw new Error(`Kino smoke ended with ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const polled = await binding.request({ gameId, path: `/generations/${encodeURIComponent(generationId)}`, method: 'GET' });
    const value = JSON.parse(new TextDecoder().decode(polled.body)) as {
      data?: { status?: string; resource?: { url?: string }; result_url?: string };
    };
    status = value.data?.status ?? 'failed';
    outputUrl = value.data?.resource?.url ?? value.data?.result_url;
  }
  if (status !== 'succeeded' || !outputUrl) throw new Error('Kino smoke timed out without an output');
  const output = await binding.download({
    gameId,
    locator: outputUrl,
    maxBytes: 512 * 1024 * 1024,
    allowedContentTypes: ['video/mp4'],
  });
  if (output.bytes.byteLength === 0) throw new Error('Kino smoke produced an empty output');
  return {
    jobIdHash: hashJobId(generationId),
    assets: [{ id: `host-${hashJobId(`${generationId}:asset`)}`, type: 'video', contentType: 'video/mp4' }],
  };
}

const realSmoke = process.env.RUN_REAL_KINO_SMOKE === '1';
const smoke = realSmoke ? test : test.skip;

describe('ForgeaX real Kino smoke (opt-in)', () => {
  smoke('generates and imports one five-second video', async () => {
    const result = await generateOnce({
      prompt: 'A paper boat drifting through a calm moonlit canal, no text',
      durationSeconds: 5,
      idempotencyKey: 'real-kino-smoke-v1',
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ type: 'video', contentType: 'video/mp4' });
    expect(result.jobIdHash).toMatch(/^[a-f0-9]{16}$/u);
  });
});
