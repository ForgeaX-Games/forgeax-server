export class VideoAssetConfigError extends Error {
  readonly name = 'VideoAssetConfigError';

  constructor(message: string) {
    super(message);
  }
}

export interface LocalVideoStorageConfig {
  kind: 'local';
}

export interface S3VideoStorageConfig {
  kind: 's3';
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  prefix?: string;
}

export interface CosVideoStorageConfig {
  kind: 'cos';
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  endpoint?: string;
  prefix?: string;
}

export type VideoStorageConfig =
  | LocalVideoStorageConfig
  | S3VideoStorageConfig
  | CosVideoStorageConfig;

const OBJECT_KEY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i;

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeVideoObjectPrefix(
  raw: string | undefined,
  configKey = 'video storage prefix',
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const normalized = trimmed.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new VideoAssetConfigError(`Invalid ${configKey}`);
  }
  return normalized;
}

export function buildVideoObjectKeyPrefix(gameId: string, prefix?: string): string {
  return prefix ? `${prefix}/${gameId}` : gameId;
}

export function buildVideoObjectKey(gameId: string, uuid: string, prefix?: string): string {
  return `${buildVideoObjectKeyPrefix(gameId, prefix)}/${uuid}.mp4`;
}

export function assertScopedVideoObjectKey(
  key: string,
  gameId: string,
  prefix?: string,
): void {
  if (
    key.includes('\0') ||
    key.includes('..') ||
    key.startsWith('/') ||
    key.startsWith('\\')
  ) {
    throw new Error('invalid scoped key');
  }

  const expectedPrefix = buildVideoObjectKeyPrefix(gameId, prefix);
  if (!key.startsWith(`${expectedPrefix}/`)) {
    throw new Error('invalid scoped key');
  }

  const suffix = key.slice(expectedPrefix.length + 1);
  if (!OBJECT_KEY_UUID_RE.test(suffix)) {
    throw new Error('invalid scoped key');
  }
}

function missingRequiredKeys(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => readEnvValue(env, key) === undefined);
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host === '::1' || host === '[::1]') {
    return true;
  }

  const ipv4Match = /^\d{1,3}(?:\.\d{1,3}){3}$/.exec(host);
  if (!ipv4Match) {
    return false;
  }

  const parts = host.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname.endsWith('.')) {
    return false;
  }
  const labels = hostname.split('.');
  if (labels.length < 2) {
    return false;
  }
  return labels.every((label) => label.length > 0 && label.length <= 63 && DNS_LABEL_RE.test(label));
}

export function normalizeCosVideoEndpoint(
  raw: string | undefined,
  configKey = 'FORGEAX_VIDEO_COS_ENDPOINT',
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let hostname: string;
  if (trimmed.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    if (parsed.username || parsed.password) {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    if (parsed.search || parsed.hash) {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    if (parsed.port) {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    hostname = parsed.hostname.toLowerCase();
  } else {
    if (/[/:?#@]/.test(trimmed)) {
      throw new VideoAssetConfigError(`Invalid ${configKey}`);
    }
    hostname = trimmed.toLowerCase();
  }

  if (isPrivateOrLocalHost(hostname) || !isValidDnsHostname(hostname)) {
    throw new VideoAssetConfigError(`Invalid ${configKey}`);
  }
  return hostname;
}

export function parseVideoStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): VideoStorageConfig {
  const storage = readEnvValue(env, 'FORGEAX_VIDEO_STORAGE') ?? 'local';

  if (storage === 'local') {
    return { kind: 'local' };
  }

  if (storage === 's3') {
    const missing = missingRequiredKeys(env, [
      'FORGEAX_VIDEO_S3_BUCKET',
      'FORGEAX_VIDEO_S3_REGION',
      'FORGEAX_VIDEO_S3_ACCESS_KEY_ID',
      'FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY',
    ]);
    if (missing.length > 0) {
      throw new VideoAssetConfigError(
        `Missing required S3 configuration: ${missing.join(', ')}`,
      );
    }

    return {
      kind: 's3',
      bucket: readEnvValue(env, 'FORGEAX_VIDEO_S3_BUCKET')!,
      region: readEnvValue(env, 'FORGEAX_VIDEO_S3_REGION')!,
      accessKeyId: readEnvValue(env, 'FORGEAX_VIDEO_S3_ACCESS_KEY_ID')!,
      secretAccessKey: readEnvValue(env, 'FORGEAX_VIDEO_S3_SECRET_ACCESS_KEY')!,
      endpoint: readEnvValue(env, 'FORGEAX_VIDEO_S3_ENDPOINT'),
      prefix: normalizeVideoObjectPrefix(
        env.FORGEAX_VIDEO_S3_PREFIX,
        'FORGEAX_VIDEO_S3_PREFIX',
      ),
    };
  }

  if (storage === 'cos') {
    const missing = missingRequiredKeys(env, [
      'FORGEAX_VIDEO_COS_BUCKET',
      'FORGEAX_VIDEO_COS_REGION',
      'FORGEAX_VIDEO_COS_SECRET_ID',
      'FORGEAX_VIDEO_COS_SECRET_KEY',
    ]);
    if (missing.length > 0) {
      throw new VideoAssetConfigError(
        `Missing required COS configuration: ${missing.join(', ')}`,
      );
    }

    return {
      kind: 'cos',
      bucket: readEnvValue(env, 'FORGEAX_VIDEO_COS_BUCKET')!,
      region: readEnvValue(env, 'FORGEAX_VIDEO_COS_REGION')!,
      secretId: readEnvValue(env, 'FORGEAX_VIDEO_COS_SECRET_ID')!,
      secretKey: readEnvValue(env, 'FORGEAX_VIDEO_COS_SECRET_KEY')!,
      endpoint: normalizeCosVideoEndpoint(
        readEnvValue(env, 'FORGEAX_VIDEO_COS_ENDPOINT'),
        'FORGEAX_VIDEO_COS_ENDPOINT',
      ),
      prefix: normalizeVideoObjectPrefix(
        env.FORGEAX_VIDEO_COS_PREFIX,
        'FORGEAX_VIDEO_COS_PREFIX',
      ),
    };
  }

  throw new VideoAssetConfigError(`Invalid FORGEAX_VIDEO_STORAGE value: ${storage}`);
}
