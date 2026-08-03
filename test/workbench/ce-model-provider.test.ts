import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createForgeaxCeModelProvider } from '../../src/workbench/ce-model-provider';

describe('createForgeaxCeModelProvider', () => {
  test('preserves the CE text and image provider request/response contract', async () => {
    const app = new Hono();
    const bodies: unknown[] = [];
    app.post('/gemini-text', async (c) => {
      bodies.push(await c.req.json());
      return c.json({ success: true, text: 'script', upstreamModel: 'actual-text' });
    });
    app.post('/generate-image', async (c) => {
      bodies.push(await c.req.json());
      return c.json({
        success: true,
        imageBase64: 'AQID',
        mimeType: 'image/png',
        modelId: 'actual-image',
        vendor: 'gemini',
      });
    });
    const provider = createForgeaxCeModelProvider(app);

    expect(await provider.generateText({
      gameId: 'game-1',
      prompt: 'write',
      system: 'director',
      model: 'text-request',
      temperature: 0.5,
      maxTokens: 100,
    })).toMatchObject({ text: 'script', model: 'actual-text' });
    expect(await provider.generateImage({
      gameId: 'game-1',
      prompt: 'frame',
      model: 'image-request',
      aspectRatio: '16:9',
      references: ['data:image/png;base64,BAUG'],
    })).toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      model: 'actual-image',
    });
    expect(bodies).toEqual([
      {
        prompt: 'write',
        system: 'director',
        model: 'text-request',
        temperature: 0.5,
        maxTokens: 100,
      },
      {
        prompt: 'frame',
        model: 'image-request',
        aspectRatio: '16:9',
        inputImages: [{ base64: 'BAUG', mimeType: 'image/png' }],
      },
    ]);
  });

  test('polls the existing CE video gateway and downloads completed bytes', async () => {
    const app = new Hono();
    let polls = 0;
    let createBody: unknown;
    app.post('/generate-video', async (c) => {
      createBody = await c.req.json();
      return c.json({ success: true, taskId: 'video-task' });
    });
    app.get('/video-status', (c) => {
      polls += 1;
      return c.json(polls === 1
        ? { success: true, status: 'in_progress' }
        : { success: true, status: 'completed', videoUrl: '/__ce-api__/video-file/hash' });
    });
    app.get('/video-file/hash', () => new Response(new Uint8Array([7, 8, 9]), {
      headers: { 'content-type': 'video/mp4' },
    }));
    const provider = createForgeaxCeModelProvider(app, {
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const result = await provider.generateVideo({
      gameId: 'game-1',
      prompt: 'clip',
      model: 'video-request',
      durationSeconds: 5,
      aspectRatio: '9:16',
      references: ['data:image/png;base64,AQID'],
      metadata: { generateAudio: true },
    });

    expect(createBody).toEqual({
      prompt: 'clip',
      model: 'video-request',
      seconds: 5,
      ratio: '9:16',
      generateAudio: true,
      imageWithRoles: [{
        role: 'reference_image',
        url: 'data:image/png;base64,AQID',
      }],
    });
    expect(result).toMatchObject({
      bytes: new Uint8Array([7, 8, 9]),
      contentType: 'video/mp4',
      operationId: 'video-task',
    });
  });
});
