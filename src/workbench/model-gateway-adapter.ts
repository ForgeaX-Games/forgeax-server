import { createHash } from 'node:crypto';
import type {
  ImageGenerationInput,
  MediaCapability,
  MediaReference,
  ModelGateway,
  TextGenerationInput,
  TextGenerationResult,
  VideoGenerationInput,
} from '@forgeax/workbench-host/contracts';
import { WorkbenchError } from '@forgeax/workbench-host/contracts';

export interface ForgeaxTextProviderInput extends TextGenerationInput {
  readonly gameId: string;
}

export interface ForgeaxMediaProviderInput {
  readonly gameId: string;
  readonly prompt: string;
  readonly references: string[];
  readonly model?: string;
  readonly aspectRatio?: string;
  readonly durationSeconds?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ForgeaxGeneratedMedia {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  readonly model?: string;
  readonly operationId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ForgeaxModelProvider {
  generateText(input: ForgeaxTextProviderInput): Promise<TextGenerationResult>;
  generateImage(input: ForgeaxMediaProviderInput): Promise<ForgeaxGeneratedMedia>;
  generateVideo(input: ForgeaxMediaProviderInput): Promise<ForgeaxGeneratedMedia>;
}

async function resolveReferences(
  media: MediaCapability,
  gameId: string,
  references: readonly MediaReference[] | undefined,
): Promise<string[]> {
  const result: string[] = [];
  for (const reference of references ?? []) {
    if ((reference as { readonly url?: unknown }).url !== undefined) {
      throw new TypeError('Model references must use a host media asset id');
    }
    if (!reference.assetId) {
      throw new TypeError('Model reference asset id is required');
    }
    const body = await media.read(gameId, reference.assetId);
    if (!body) {
      throw new TypeError(`Model reference was not found: ${reference.assetId}`);
    }
    result.push(`data:${body.contentType};base64,${Buffer.from(body.bytes).toString('base64')}`);
  }
  return result;
}

function operationKey(
  kind: 'image' | 'video',
  generated: ForgeaxGeneratedMedia,
): string {
  const identity = generated.operationId ?? createHash('sha256')
    .update(generated.contentType)
    .update('\0')
    .update(generated.bytes)
    .digest('hex');
  return `model:${kind}:${identity}`;
}

async function persistGenerated(
  media: MediaCapability,
  gameId: string,
  kind: 'image' | 'video',
  generated: ForgeaxGeneratedMedia,
) {
  const asset = await media.put(gameId, {
    filename: generated.filename,
    contentType: generated.contentType,
    bytes: generated.bytes,
    idempotencyKey: operationKey(kind, generated),
    metadata: {
      ...(generated.metadata ?? {}),
      ...(generated.model ? { model: generated.model } : {}),
      ...(generated.operationId ? { operationId: generated.operationId } : {}),
    },
  });
  return {
    assets: [asset],
    model: generated.model,
    metadata: generated.metadata,
  };
}

/** Adapt ForgeaX's product model gateways to the game-bound Host contract. */
export function createForgeaxModelGateway(
  provider: ForgeaxModelProvider,
  media: MediaCapability,
): ModelGateway {
  return {
    generateText(gameId, input) {
      return provider.generateText({
        gameId,
        prompt: input.prompt,
        system: input.system,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        metadata: input.metadata,
      });
    },

    async generateImage(gameId, input: ImageGenerationInput) {
      const generated = await provider.generateImage({
        gameId,
        prompt: input.prompt,
        references: await resolveReferences(media, gameId, input.references),
        model: input.model,
        aspectRatio: input.aspectRatio,
        metadata: input.metadata,
      });
      return persistGenerated(media, gameId, 'image', generated);
    },

    async generateVideo(gameId, input: VideoGenerationInput) {
      void gameId;
      void input;
      throw new WorkbenchError({
        code: 'capability_unavailable',
        target: 'media.video.generate@1',
        message: 'Video generation is provided by the selected Workbench capability',
        retryable: false,
      });
    },
  };
}
