import { createHash } from 'node:crypto';

export const PROVIDER_BUNDLE_SCHEMA = 'forgeax.asset3d-provider-bundle/1.0.0';
export const PROVIDER_RESULT_SCHEMA = 'forgeax.asset3d-search-result/1.0.0';
export const PROVIDER_RECEIPT_SCHEMA = 'forgeax.asset3d-search-receipt/1.0.0';
export const RESULT_SCHEMA_SHA256 = 'ab6e5e1e794d5428efef362fe32d4c54b6541e12539bae5f6ff27680c9f380ba';
export const RECEIPT_SCHEMA_SHA256 = 'e0dc9e9fe9872f09af9fca6d0c17d22aca63c2b546c55c0b669c581f7059b9c4';
export const ASSET3D_PROVIDER_COMMIT = 'c181c48fbffc933a7ce9a0836f7878ca5e6d77e1';
export const BUNDLED_ASSET3D_PROVIDERS = Object.freeze({
  'darwin-arm64': {
    sha256: '9492c507a3afe5cafcd50b5f782b313c8716c2e52f5def06592c6a100c0459db',
    relativePath: 'asset3d/provider/asset3d-search-provider-c181c48fbffc933a7ce9a0836f7878ca5e6d77e1-darwin-arm64.tar.gz',
  },
  'linux-x64': {
    sha256: 'e6ac3df76c8b82f9fe2c063dd3f221324a9dad5176fd52535a5144b0ff6002d8',
    relativePath: 'asset3d/provider/asset3d-search-provider-c181c48fbffc933a7ce9a0836f7878ca5e6d77e1-linux-x64.tar.gz',
  },
} as const);
export const MAX_JSON_BYTES = 1024 * 1024;
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
