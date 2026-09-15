import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalizeOrigins } from './origins';

const AW_SERVICE_PATH = '/trpc.oasismetric.omcontentserver.http';
const ACCESS_CHECK_SCHEMA = 'forgeax.asset3d-access-check/1.0.0';
export type AssetLibraryId = 'aw' | 'ea';

export interface AssetLibraryAccessCheck {
  readonly serviceRoot: string;
  readonly authentication: 'sandbox-key';
  readonly downloadOrigins: readonly string[];
}

export function normalizeAssetLibraryServiceRoot(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error('asset3d_base_url_invalid: expected an HTTP(S) EA gateway or service URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('asset3d_base_url_invalid: credentials, query, and fragment are forbidden');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith(`${AW_SERVICE_PATH}/HybridSearch`)) path = path.slice(0, -'/HybridSearch'.length);
  else if (!path.endsWith(AW_SERVICE_PATH)) path = `${path}${AW_SERVICE_PATH}`;
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

export function resolveAssetLibrarySelection(options: {
  readonly library?: string;
  readonly baseUrl?: string;
} = {}): { readonly library: AssetLibraryId; readonly serviceRoot: string } {
  const library = options.library || process.env.FORGEAX_ASSET_LIBRARY || 'ea';
  if (library !== 'aw' && library !== 'ea') {
    throw new Error('asset3d_library_invalid: expected aw or ea');
  }
  const configured = options.baseUrl || process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
  if (!configured?.trim()) {
    throw new Error('asset3d_base_url_required: configure FORGEAX_ASSET_LIBRARY_BASE_URL before using the asset library');
  }
  return { library, serviceRoot: normalizeAssetLibraryServiceRoot(configured) };
}

export function checkAssetLibraryProviderAccess(options: {
  readonly providerCache: string;
  readonly depotName: AssetLibraryId;
  readonly serviceRoot: string;
  readonly credentialFile: string;
}): AssetLibraryAccessCheck {
  const command = resolve(options.providerCache, 'bin', 'asset3d-search');
  if (!existsSync(command)) throw new Error('asset3d_provider_not_prepared');
  const result = spawnSync(command, ['--check-aw-access'], {
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      ASSET3D_CATALOG_BASE_URL: '',
      AW_API_BASE_URL: options.serviceRoot,
      AW_API_DEPOT_NAME: options.depotName,
      AW_API_CREDENTIAL_FILE: resolve(options.credentialFile),
      AW_API_SANDBOX_KEY: '',
    },
  });
  return parseAssetLibraryAccessResult(result, options.serviceRoot);
}

/** Decode only public error codes; never forward subprocess output or upstream messages. */
export function parseAssetLibraryAccessResult(result: {
  readonly stdout: string | null;
  readonly status: number | null;
  readonly signal?: string | null;
  readonly error?: Error & { code?: string };
}, serviceRoot: string): AssetLibraryAccessCheck {
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT'
      ? 'asset3d_access_check_timeout'
      : 'asset3d_access_check_process_failed';
    throw new Error(`${code}: Provider access check could not complete; credential validity is unknown`);
  }
  if (result.signal || result.status === null) {
    throw new Error('asset3d_access_check_process_failed: Provider access check terminated; credential validity is unknown');
  }
  let payload: unknown;
  try { payload = JSON.parse(result.stdout ?? ''); }
  catch { throw new Error('asset3d_access_validation_failed: Provider returned an invalid response'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('asset3d_access_validation_failed: Provider returned an invalid response');
  }
  const envelope = payload as {
    schemaVersion?: unknown;
    ok?: unknown;
    value?: { authentication?: unknown; downloadOrigins?: unknown };
    error?: { code?: unknown };
  };
  if (envelope.schemaVersion !== ACCESS_CHECK_SCHEMA || typeof envelope.ok !== 'boolean') {
    throw new Error('asset3d_access_validation_failed: Provider returned an invalid response');
  }
  if (envelope.ok === false) {
    const messages: Readonly<Record<string, string>> = {
      search_timeout: 'selected asset-library service timed out',
      search_upstream_error: 'selected asset-library service failed; credential validity is unknown',
      asset3d_access_validation_inconclusive: 'Provider could not establish access and download origins',
      asset3d_api_key_invalid_or_unavailable: 'Provider did not distinguish service, network and authentication failure; invalid credentials are not established',
    };
    const code = envelope.error?.code;
    if (typeof code === 'string' && Object.hasOwn(messages, code)) {
      throw new Error(`${code}: ${messages[code]}`);
    }
    throw new Error('asset3d_access_validation_failed: Provider access check failed without a recognized cause; credential validity is unknown');
  }
  if (result.status !== 0) {
    throw new Error('asset3d_access_check_process_failed: Provider exited unsuccessfully despite a success response');
  }
  if (envelope.value?.authentication !== 'sandbox-key' || !Array.isArray(envelope.value.downloadOrigins)) {
    throw new Error('asset3d_access_validation_failed: Provider returned an invalid response');
  }
  const origins = canonicalizeOrigins(envelope.value.downloadOrigins as string[]).values;
  return { serviceRoot, authentication: 'sandbox-key', downloadOrigins: origins };
}
