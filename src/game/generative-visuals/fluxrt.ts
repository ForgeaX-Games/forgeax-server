import { Hono } from 'hono';
import {
  createGenerativeVisualAccessPolicy,
  type GenerativeVisualAccessPolicy,
} from './access-policy';

interface FrameEnhancementCapabilities {
  streaming: boolean;
  supportsPrompt: boolean;
  supportsInterp: boolean;
  outputResolution?: { width: number; height: number };
}

interface PredictOnceRequest {
  base64_image: string;
  prompt?: string;
  seed?: number;
  steps?: number;
  interp?: number;
  reset_cache?: boolean;
}

interface PredictOnceResult {
  ok: boolean;
  status: number;
  data?: Record<string, unknown>;
  error?: string;
}

const BACKEND_NAME = 'fluxrt';

function baseUrl(): string {
  return (process.env.FLUXRT_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

function serviceKey(): string {
  return (process.env.FLUXRT_API_KEY ?? '').trim();
}

function isReady(): boolean {
  return baseUrl().length > 0 && serviceKey().length > 0;
}

function capabilities(): FrameEnhancementCapabilities {
  return {
    streaming: true,
    supportsPrompt: true,
    supportsInterp: true,
    outputResolution: { width: 576, height: 320 },
  };
}

async function health(): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const base = baseUrl();
  if (!base) return { ok: false, status: 503, error: 'FLUXRT_BASE_URL not set' };
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(12_000) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}

async function predictOnce(req: PredictOnceRequest): Promise<PredictOnceResult> {
  const base = baseUrl();
  const key = serviceKey();
  if (!base) return { ok: false, status: 503, error: 'FLUXRT_BASE_URL not set' };
  if (!key) return { ok: false, status: 401, error: 'FLUXRT_API_KEY is not set' };
  if (!req.base64_image) return { ok: false, status: 400, error: 'base64_image required' };
  try {
    const res = await fetch(`${base}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        base64_image: req.base64_image,
        ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(req.steps !== undefined ? { steps: req.steps } : {}),
        ...(req.interp !== undefined ? { interp: req.interp } : {}),
        ...(req.reset_cache !== undefined ? { reset_cache: req.reset_cache } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (data as { error?: string }).error ?? `upstream HTTP ${res.status}`;
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, status: 200, data: data as Record<string, unknown> };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * FluxRT is intentionally the one provider that uses the ForgeaX WS relay:
 * frames are JPEG binary payloads and the backend key stays server-side.
 */
export function getFluxRtWsUpstreamUrl(): string | null {
  const base = baseUrl();
  const key = serviceKey();
  if (!base || !key) return null;
  return `${base.replace(/^http/i, 'ws')}/ws?key=${encodeURIComponent(key)}`;
}

export interface FluxRtRouterOptions {
  readonly accessPolicy?: GenerativeVisualAccessPolicy;
}

export function createFluxRtRouter(options: FluxRtRouterOptions = {}): Hono {
  const accessPolicy = options.accessPolicy ?? createGenerativeVisualAccessPolicy();
  const router = new Hono();

  router.get('/backends', (c) => c.json({
    backends: [{
      name: BACKEND_NAME,
      ready: isReady(),
      capabilities: capabilities(),
    }],
  }));

  router.get('/health', async (c) => {
    const result = await health();
    return c.json(
      { backend: BACKEND_NAME, ready: isReady(), ...result },
      (result.ok ? 200 : result.status) as 200,
    );
  });

  router.post('/predict', async (c) => {
    const access = accessPolicy.authorize(c.req.raw);
    if (!access.ok) return c.json({ error: access.error }, access.status);
    let body: PredictOnceRequest;
    try {
      body = await c.req.json<PredictOnceRequest>();
    } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }
    const result = await predictOnce(body);
    if (result.ok) return c.json(result.data ?? {});
    return c.json({ error: result.error, backend: BACKEND_NAME }, (result.status || 500) as 500);
  });

  return router;
}
