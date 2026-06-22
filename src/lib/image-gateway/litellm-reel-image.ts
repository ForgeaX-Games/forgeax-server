// litellm image path for wb-reel (互动影游) — pins gpt-image-2 and routes
// through the proxy's OpenAI-shaped image API. Honors the author constraint
// 「固定图像只用 image2」 while keeping the litellm key server-side.
//
// Verified (2026-06, LITELLM_PROXY_BASE_URL):
//   · /v1/images/generations and /v1/images/edits routes are allowed; model
//     `gpt-image-2` is in the key's allowlist; edits requires an `image` file.
//
// Two paths:
//   · no reference images → POST {base}/images/generations  (JSON)
//   · ≥1 reference image  → POST {base}/images/edits         (multipart, image[])
// Both request response_format=b64_json and return the first image as base64.

const REEL_IMAGE_MODEL = 'gpt-image-2';

function proxyBase(): string {
  return (process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
}
function proxyKey(): string {
  return process.env.LITELLM_PROXY_KEY ?? '';
}

export function litellmImageConfigured(): boolean {
  return !!(proxyBase() && proxyKey());
}

export interface ReelImageInput {
  prompt: string;
  /** gpt-image-2 sizes: 1024x1024 | 1024x1536 | 1536x1024 | auto. */
  size?: string;
  /** Reference images as pure base64 (no data: prefix). ≥1 → edits path. */
  referenceImagesB64?: string[];
}

export interface ReelImageResult {
  b64: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  modelId: string;
}

interface LiteLLMImageResp {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

function sniffMime(b64: string): ReelImageResult['mime'] {
  // PNG: iVBOR... ; JPEG: /9j/ ; WEBP: UklGR
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function normalizeSize(size: string | undefined): string {
  const allowed = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
  if (size && allowed.has(size)) return size;
  return '1024x1024';
}

async function parseImageResponse(resp: Response): Promise<ReelImageResult> {
  const raw = await resp.text();
  let parsed: LiteLLMImageResp;
  try {
    parsed = JSON.parse(raw) as LiteLLMImageResp;
  } catch {
    throw new Error(`litellm-image: non-JSON (HTTP ${resp.status}) · ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`litellm-image: ${parsed.error?.message ?? `HTTP ${resp.status}`}`);
  }
  const b64 = parsed.data?.[0]?.b64_json;
  if (!b64) throw new Error('litellm-image: response missing data[0].b64_json');
  return { b64, mime: sniffMime(b64), modelId: REEL_IMAGE_MODEL };
}

export async function generateReelImage(input: ReelImageInput): Promise<ReelImageResult> {
  const base = proxyBase();
  const key = proxyKey();
  if (!base) throw new Error('litellm-image: LITELLM_PROXY_BASE_URL not set');
  if (!key) throw new Error('litellm-image: LITELLM_PROXY_KEY not set');
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('litellm-image: empty prompt');
  const size = normalizeSize(input.size);
  const refs = (input.referenceImagesB64 ?? []).filter((b) => !!b);

  if (refs.length === 0) {
    const resp = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: REEL_IMAGE_MODEL,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
    });
    return parseImageResponse(resp);
  }

  // Reference images → edits (multipart). gpt-image-2 accepts multiple `image`.
  const fd = new FormData();
  fd.append('model', REEL_IMAGE_MODEL);
  fd.append('prompt', prompt);
  fd.append('n', '1');
  fd.append('size', size);
  fd.append('response_format', 'b64_json');
  refs.forEach((b64, i) => {
    const bytes = Buffer.from(b64, 'base64');
    const blob = new Blob([bytes], { type: 'image/png' });
    fd.append('image[]', blob, `ref_${i}.png`);
  });
  const resp = await fetch(`${base}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  return parseImageResponse(resp);
}
