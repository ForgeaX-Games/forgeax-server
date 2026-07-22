import { expect, test } from 'bun:test';
import type { VideoAssetProvider } from '../../src/video-assets/contracts';
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

test('control is frozen and exposes only setProvider', () => {
  const registry = new VideoAssetProviderRegistry(provider('local'));

  expect(Object.isFrozen(registry.control)).toBe(true);
  expect(Object.keys(registry.control)).toEqual(['setProvider']);
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
