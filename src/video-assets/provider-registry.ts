import type {
  VideoAssetProvider,
  VideoAssetProviderControl,
  VideoAssetProviderKind,
} from './contracts';

const PROVIDER_KINDS: readonly VideoAssetProviderKind[] = ['local', 's3', 'cos', 'kino'];
const REQUIRED_METHODS = [
  'prepareUpload',
  'inspectUpload',
  'finalizeResource',
  'getPlayback',
  'delete',
] as const;

function assertVideoAssetProvider(value: unknown): asserts value is VideoAssetProvider {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid video asset provider');
  }

  const provider = value as VideoAssetProvider;
  if (!PROVIDER_KINDS.includes(provider.kind)) {
    throw new Error('Invalid video asset provider');
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error('Invalid video asset provider');
    }
  }
}

export class VideoAssetProviderRegistry {
  #provider: VideoAssetProvider;
  readonly control: VideoAssetProviderControl;

  constructor(defaultProvider: VideoAssetProvider) {
    assertVideoAssetProvider(defaultProvider);
    this.#provider = defaultProvider;
    this.control = Object.freeze({
      setProvider: (provider: VideoAssetProvider) => {
        assertVideoAssetProvider(provider);
        this.#provider = provider;
      },
    });
  }

  current(): VideoAssetProvider {
    return this.#provider;
  }
}
