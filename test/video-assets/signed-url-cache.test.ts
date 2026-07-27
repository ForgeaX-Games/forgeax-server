import { describe, expect, test } from 'bun:test';
import { createExpiringUrlCache } from '../../src/video-assets/providers/signed-url-cache';

describe('createExpiringUrlCache', () => {
  test('coalesces concurrent signing and refreshes after expiry', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createExpiringUrlCache(240_000, () => now);
    const load = async () => `https://cdn.example/video.mp4?sig=${++calls}`;

    const [first, concurrent] = await Promise.all([
      cache.get('video', load),
      cache.get('video', load),
    ]);
    expect(first).toBe(concurrent);
    expect(calls).toBe(1);

    now += 240_000;
    await expect(cache.get('video', load)).resolves.toContain('sig=2');
    expect(calls).toBe(2);
  });

  test('does not retain failed signing attempts', async () => {
    let calls = 0;
    const cache = createExpiringUrlCache(240_000);
    const load = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('signing failed');
      }
      return 'https://cdn.example/video.mp4?sig=recovered';
    };

    await expect(cache.get('video', load)).rejects.toThrow('signing failed');
    await expect(cache.get('video', load)).resolves.toContain('recovered');
    expect(calls).toBe(2);
  });

  test('bounds retained URLs by evicting the oldest entry', async () => {
    let calls = 0;
    const cache = createExpiringUrlCache(240_000, Date.now, 2);
    const load = async () => `signed-${++calls}`;

    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('c', load);
    await cache.get('a', load);

    expect(calls).toBe(4);
  });
});
