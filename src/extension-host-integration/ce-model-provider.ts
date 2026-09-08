import type { Hono } from 'hono';
import type {
  ForgeaxGeneratedMedia,
  ForgeaxMediaProviderInput,
  ForgeaxModelProvider,
  ForgeaxTextProviderInput,
} from './model-gateway-adapter';

interface CeEnvelope {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ForgeaxCeModelProviderOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ceJson(
  router: Hono,
  path: string,
  init?: RequestInit,
): Promise<CeEnvelope> {
  const response = await router.request(path, init);
  const body = await response.json() as CeEnvelope;
  if (!response.ok || body.success === false) {
    throw new Error(body.error || `CE provider request failed: ${response.status}`);
  }
  return body;
}

function parseDataUrl(url: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.+)$/su.exec(url);
  if (!match) throw new TypeError('CE model references must be base64 data URLs');
  return { mimeType: match[1]!, base64: match[2]! };
}

function extensionFor(contentType: string, fallback: string): string {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'video/mp4') return 'mp4';
  return fallback;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Reuse ForgeaX's existing CE provider routes without exposing provider keys. */
export function createForgeaxCeModelProvider(
  router: Hono,
  options: ForgeaxCeModelProviderOptions = {},
): ForgeaxModelProvider {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async generateText(input: ForgeaxTextProviderInput) {
      const result = await ceJson(router, '/gemini-text', jsonPost({
        prompt: input.prompt,
        system: input.system,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      }));
      if (typeof result.text !== 'string') {
        throw new Error('CE text provider returned no text');
      }
      return {
        text: result.text,
        model: typeof result.upstreamModel === 'string'
          ? result.upstreamModel
          : input.model,
      };
    },

    async generateImage(input: ForgeaxMediaProviderInput): Promise<ForgeaxGeneratedMedia> {
      const result = await ceJson(router, '/generate-image', jsonPost({
        prompt: input.prompt,
        model: input.model,
        aspectRatio: input.aspectRatio,
        inputImages: input.references.map((reference) => {
          const parsed = parseDataUrl(reference);
          return { base64: parsed.base64, mimeType: parsed.mimeType };
        }),
      }));
      if (typeof result.imageBase64 !== 'string') {
        throw new Error('CE image provider returned no image');
      }
      const contentType = typeof result.mimeType === 'string'
        ? result.mimeType
        : 'image/png';
      const model = typeof result.modelId === 'string' ? result.modelId : input.model;
      return {
        bytes: new Uint8Array(Buffer.from(result.imageBase64, 'base64')),
        contentType,
        filename: `generated-${Date.now()}.${extensionFor(contentType, 'png')}`,
        model,
        metadata: {
          ...(typeof result.vendor === 'string' ? { vendor: result.vendor } : {}),
        },
      };
    },

    async generateVideo(input: ForgeaxMediaProviderInput): Promise<ForgeaxGeneratedMedia> {
      const created = await ceJson(router, '/generate-video', jsonPost({
        prompt: input.prompt,
        model: input.model,
        seconds: input.durationSeconds,
        ratio: input.aspectRatio,
        generateAudio: input.metadata?.generateAudio === true,
        imageWithRoles: input.references.map((url) => ({
          role: 'reference_image',
          url,
        })),
      }));
      if (typeof created.taskId !== 'string') {
        throw new Error('CE video provider returned no task id');
      }

      const startedAt = Date.now();
      let videoUrl: string | undefined;
      while (Date.now() - startedAt <= timeoutMs) {
        const status = await ceJson(
          router,
          `/video-status?taskId=${encodeURIComponent(created.taskId)}`,
        );
        if (status.status === 'failed') {
          throw new Error(
            typeof status.error === 'string'
              ? status.error
              : 'CE video generation failed',
          );
        }
        if (status.status === 'completed' && typeof status.videoUrl === 'string') {
          videoUrl = status.videoUrl;
          break;
        }
        await sleep(pollIntervalMs);
      }
      if (!videoUrl) throw new Error('CE video generation timed out');

      const localPath = videoUrl.startsWith('/__ce-api__/')
        ? videoUrl.slice('/__ce-api__'.length)
        : videoUrl;
      const response = await router.request(localPath);
      if (!response.ok) {
        throw new Error(`CE video download failed: ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? 'video/mp4';
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType,
        filename: `generated-${Date.now()}.${extensionFor(contentType, 'mp4')}`,
        model: input.model,
        operationId: created.taskId,
      };
    },
  };
}
