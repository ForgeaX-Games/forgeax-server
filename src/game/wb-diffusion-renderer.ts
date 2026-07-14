import { Hono } from 'hono';

// /api/wb/diffusion-renderer — realtime viewport diffusion renderer.
// Keeps the current single FluxRT-backed implementation in one product-shell file:
// HTTP readiness/capability routes plus the WS upstream URL used by main.ts.

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
  return (process.env.FLUXRT_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
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
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
  }
}

async function predictOnce(req: PredictOnceRequest): Promise<PredictOnceResult> {
  const base = baseUrl();
  const key = serviceKey();
  if (!base) return { ok: false, status: 503, error: 'FLUXRT_BASE_URL not set' };
  if (!key) return { ok: false, status: 401, error: 'no service key (FLUXRT_API_KEY / ANTHROPIC_API_KEY)' };
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
      const msg = (data as { error?: string }).error ?? `upstream HTTP ${res.status}`;
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, status: 200, data: data as Record<string, unknown> };
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getDiffusionRendererWsUpstreamUrl(): string | null {
  const base = baseUrl();
  const key = serviceKey();
  if (!base || !key) return null;
  const wsBase = base.replace(/^http/i, 'ws');
  return `${wsBase}/ws?key=${encodeURIComponent(key)}`;
}

export function createDiffusionRendererRouter(): Hono {
  const r = new Hono();

  // Capability-driven UI feed + backend discovery.
  r.get('/backends', (c) => c.json({
    backends: [{
      name: BACKEND_NAME,
      ready: isReady(),
      capabilities: capabilities(),
    }],
  }));

  // Readiness gate — the inline panel polls this before enabling "Diffusion Renderer".
  r.get('/health', async (c) => {
    const h = await health();
    return c.json({ backend: BACKEND_NAME, ready: isReady(), ...h }, (h.ok ? 200 : h.status) as 200);
  });

  // Phase-1 single-frame edit → routed through the backend adapter.
  r.post('/predict', async (c) => {
    let body: PredictOnceRequest;
    try { body = (await c.req.json()) as PredictOnceRequest; }
    catch { return c.json({ error: 'invalid-json' }, 400); }
    const res = await predictOnce(body);
    if (res.ok) return c.json(res.data as Record<string, unknown>);
    return c.json({ error: res.error, backend: BACKEND_NAME }, (res.status || 500) as 500);
  });

  return r;
}
