import { expect, test } from 'bun:test';
import type { VideoAssetProvider } from '../../src/video-assets/contracts';
import { createVideoAssetRuntime } from '../../src/video-assets';
import { VideoAssetProviderRegistry } from '../../src/video-assets/provider-registry';

function provider(kind: VideoAssetProvider['kind']): VideoAssetProvider {
  return {
    kind,
    prepareUpload: async () => {
      throw new Error('not used');
    },
    inspectUpload: async () => {
      throw new Error('not used');
    },
    finalizeResource: async () => {
      throw new Error('not used');
    },
    getPlayback: async () => {
      throw new Error('not used');
    },
    delete: async () => {},
  };
}

test('registry current() returns the default provider', () => {
  const defaultProvider = provider('local');
  const registry = new VideoAssetProviderRegistry(defaultProvider);

  expect(registry.current()).toBe(defaultProvider);
});

test('provider control replaces the provider used by later requests', () => {
  const registry = new VideoAssetProviderRegistry(provider('local'));
  const replacement = provider('kino');

  registry.control.setProvider(replacement);

  expect(registry.current()).toBe(replacement);
});

test('control is frozen and exposes provider replacement plus read-only template sources', () => {
  const registry = new VideoAssetProviderRegistry(provider('local'));

  expect(Object.isFrozen(registry.control)).toBe(true);
  expect(Object.keys(registry.control)).toEqual(['setProvider', 'sourceProvider']);
});

test('sourceProvider retains configured sources after the active provider changes', () => {
  const local = provider('local');
  const cos = provider('cos');
  const registry = new VideoAssetProviderRegistry(local, [cos]);

  registry.control.setProvider(provider('kino'));

  expect(registry.control.sourceProvider('local')).toBe(local);
  expect(registry.control.sourceProvider('cos')).toBe(cos);
  expect(registry.control.sourceProvider('s3')).toBeUndefined();
});

test('runtime retains a COS template source even when active storage defaults to Local', () => {
  const runtime = createVideoAssetRuntime({
    getProjectRoot: () => '/tmp/forgeax-provider-registry-test',
    env: {
      FORGEAX_VIDEO_COS_BUCKET: 'template-bucket',
      FORGEAX_VIDEO_COS_REGION: 'ap-guangzhou',
      FORGEAX_VIDEO_COS_SECRET_ID: 'AKIDTEMPLATE',
      FORGEAX_VIDEO_COS_SECRET_KEY: 'template-secret',
      FORGEAX_VIDEO_COS_PREFIX: 'forgeax/videos',
    },
  });

  expect(runtime.providerControl.sourceProvider('local')?.kind).toBe('local');
  expect(runtime.providerControl.sourceProvider('cos')?.kind).toBe('cos');
});

test('setProvider rejects invalid objects', () => {
  const registry = new VideoAssetProviderRegistry(provider('local'));

  expect(() => registry.control.setProvider(null as unknown as VideoAssetProvider)).toThrow(
    'Invalid video asset provider',
  );
  expect(() => registry.control.setProvider({ kind: 'local' } as VideoAssetProvider)).toThrow(
    'Invalid video asset provider',
  );
});
