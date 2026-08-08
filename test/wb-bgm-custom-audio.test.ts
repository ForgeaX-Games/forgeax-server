import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBgmRouter } from '../src/game/wb-bgm';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mimeType = 'audio/ogg') {
  const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-custom-preview-'));
  roots.push(projectRoot);
  const digest = 'a'.repeat(64);
  const kind = mimeType === 'audio/ogg' ? 'bgm' : 'sfx';
  const extension = mimeType === 'audio/ogg' ? '.ogg' : mimeType === 'audio/wav' ? '.wav' : '.mp3';
  const assetId = `custom:${kind}:sha256:${digest}`;
  const relativePath = `${kind}/${digest}${extension}`;
  const root = join(projectRoot, '.forgeax', 'assets', 'audio-custom');
  const bytes = Buffer.from('0123456789abcdef');
  await mkdir(join(root, kind), { recursive: true });
  await writeFile(join(root, relativePath), bytes);
  await writeFile(join(root, 'index.json'), JSON.stringify({
    schemaVersion: 'forgeax-custom-audio-library/1',
    assets: [{ assetId, kind, relativePath, mimeType, bytes: bytes.length, sha256: digest }],
  }));
  return { projectRoot, assetId, bytes, root };
}

describe('wb-bgm registered custom audio preview', () => {
  test.each(['audio/ogg', 'audio/mpeg', 'audio/wav'])(
    'streams %s and supports byte ranges',
    async (mimeType) => {
      const { projectRoot, assetId, bytes } = await fixture(mimeType);
      const router = createBgmRouter({ projectRoot });
      const path = `/custom/${encodeURIComponent(assetId)}`;

      const full = await router.request(path);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe(mimeType);
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

      const ranged = await router.request(path, { headers: { Range: 'bytes=2-5' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(`bytes 2-5/${bytes.length}`);
      expect(ranged.headers.get('content-length')).toBe('4');
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(2, 6));
    },
  );

  test('rejects invalid ranges, unknown IDs, and indexed traversal paths', async () => {
    const { projectRoot, assetId, bytes, root } = await fixture();
    const router = createBgmRouter({ projectRoot });
    const path = `/custom/${encodeURIComponent(assetId)}`;

    const invalidRange = await router.request(path, { headers: { Range: 'bytes=99-100' } });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
    expect((await router.request('/custom/custom%3Asfx%3Asha256%3Amissing')).status).toBe(404);

    await writeFile(join(root, 'index.json'), JSON.stringify({
      schemaVersion: 'forgeax-custom-audio-library/1',
      assets: [{
        assetId,
        kind: 'bgm',
        relativePath: '../outside.ogg',
        mimeType: 'audio/ogg',
        bytes: bytes.length,
        sha256: 'a'.repeat(64),
      }],
    }));
    expect((await router.request(path)).status).toBe(404);
  });
});
