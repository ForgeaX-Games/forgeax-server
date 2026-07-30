import { describe, expect, test } from 'bun:test';
import type {
  MediaAsset,
  MediaCapability,
  MediaWriteInput,
} from '@forgeax/workbench-host/contracts';
import {
  createForgeaxModelGateway,
  type ForgeaxModelProvider,
} from '../../src/workbench/model-gateway-adapter';

describe('createForgeaxModelGateway', () => {
  test('forwards text settings through the existing model provider', async () => {
    let received: unknown;
    const provider: ForgeaxModelProvider = {
      generateText: async (input) => {
        received = input;
        return {
          text: 'shot script',
          model: 'text-model',
          usage: { inputTokens: 12, outputTokens: 4 },
        };
      },
      generateImage: async () => { throw new Error('unused'); },
      generateVideo: async () => { throw new Error('unused'); },
    };
    const gateway = createForgeaxModelGateway(provider, memoryMedia());

    expect(await gateway.generateText('game-1', {
      prompt: 'write',
      system: 'director',
      model: 'requested-model',
      temperature: 0.7,
      maxTokens: 200,
    })).toEqual({
      text: 'shot script',
      model: 'text-model',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(received).toEqual({
      gameId: 'game-1',
      prompt: 'write',
      system: 'director',
      model: 'requested-model',
      temperature: 0.7,
      maxTokens: 200,
      metadata: undefined,
    });
  });

  test('resolves game-owned references and persists generated image/video bytes', async () => {
    const writes: MediaWriteInput[] = [];
    const references: string[] = [];
    const media = memoryMedia({
      reads: {
        ref: { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
      },
      writes,
    });
    const provider: ForgeaxModelProvider = {
      generateText: async () => { throw new Error('unused'); },
      generateImage: async (input) => {
        references.push(...input.references);
        return {
          bytes: new Uint8Array([4, 5]),
          contentType: 'image/png',
          filename: 'frame.png',
          model: 'image-model',
          operationId: 'image-task',
        };
      },
      generateVideo: async (input) => {
        references.push(...input.references);
        return {
          bytes: new Uint8Array([6, 7]),
          contentType: 'video/mp4',
          filename: 'clip.mp4',
          model: 'video-model',
          operationId: 'video-task',
        };
      },
    };
    const gateway = createForgeaxModelGateway(provider, media);

    const image = await gateway.generateImage('game-1', {
      prompt: 'frame',
      references: [{ assetId: 'ref' }],
      aspectRatio: '16:9',
    });
    const video = await gateway.generateVideo('game-1', {
      prompt: 'clip',
      references: [{ assetId: 'ref' }],
      durationSeconds: 5,
      aspectRatio: '16:9',
      metadata: { generateAudio: true },
    });

    expect(references).toEqual([
      'data:image/png;base64,AQID',
      'data:image/png;base64,AQID',
    ]);
    expect(writes).toEqual([
      expect.objectContaining({
        filename: 'frame.png',
        contentType: 'image/png',
        bytes: new Uint8Array([4, 5]),
        idempotencyKey: 'model:image:image-task',
      }),
      expect.objectContaining({
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        bytes: new Uint8Array([6, 7]),
        idempotencyKey: 'model:video:video-task',
      }),
    ]);
    expect(image).toMatchObject({ model: 'image-model', assets: [{ id: 'asset-1' }] });
    expect(video).toMatchObject({ model: 'video-model', assets: [{ id: 'asset-2' }] });
  });

  test('rejects external model reference URLs', async () => {
    const provider: ForgeaxModelProvider = {
      generateText: async () => { throw new Error('unused'); },
      generateImage: async () => { throw new Error('must not reach provider'); },
      generateVideo: async () => { throw new Error('unused'); },
    };
    const gateway = createForgeaxModelGateway(provider, memoryMedia());

    await expect(gateway.generateImage('game-1', {
      prompt: 'frame',
      references: [{ url: 'https://example.invalid/image.png' }],
    })).rejects.toThrow('host media asset id');
  });
});

function memoryMedia(options: {
  reads?: Record<string, { contentType: string; bytes: Uint8Array }>;
  writes?: MediaWriteInput[];
} = {}): MediaCapability {
  let id = 0;
  return {
    list: async () => [],
    read: async (_gameId, assetId) => options.reads?.[assetId] ?? null,
    put: async (_gameId, input): Promise<MediaAsset> => {
      options.writes?.push(input);
      id += 1;
      return {
        id: `asset-${id}`,
        type: input.contentType.startsWith('image/') ? 'image' : 'video',
        contentType: input.contentType,
        url: `/media/asset-${id}`,
      };
    },
    delete: async () => {},
  };
}
