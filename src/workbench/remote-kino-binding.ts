import { createHmac } from 'node:crypto';
import {
  WorkbenchError,
  type ServiceBinding,
} from '@forgeax/workbench-host/contracts';
import { createKinoServiceBinding } from '@forgeax-extension/wb-asset-canvas/kino-binding';
import { getOrCreateKinoInstallationId } from './kino-installation-id';

const REQUIRED_ENVIRONMENT = [
  'FORGEAX_KINO_BASE_URL',
  'FORGEAX_KINO_GATEWAY_TOKEN',
  'FORGEAX_KINO_NAMESPACE_SECRET',
  'FORGEAX_KINO_OUTPUT_ORIGINS',
] as const;

export interface ForgeaxKinoEnvironment {
  readonly FORGEAX_KINO_BASE_URL?: string;
  readonly FORGEAX_KINO_GATEWAY_TOKEN?: string;
  readonly FORGEAX_KINO_NAMESPACE_SECRET?: string;
  readonly FORGEAX_KINO_OUTPUT_ORIGINS?: string;
}

export interface RemoteKinoBindingOptions {
  readonly projectRoot: string;
  readonly env?: ForgeaxKinoEnvironment;
  readonly installationId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function configurationError(message: string): WorkbenchError {
  return new WorkbenchError({
    code: 'service_configuration_invalid',
    target: 'service.arrival-kino',
    message,
    retryable: false,
  });
}

function environment(options: RemoteKinoBindingOptions): ForgeaxKinoEnvironment {
  return (options.env ?? process.env) as ForgeaxKinoEnvironment;
}

function required(value: string | undefined, name: (typeof REQUIRED_ENVIRONMENT)[number]): string {
  if (!value || value.trim().length === 0) {
    throw configurationError(`${name} is required for ForgeaX Kino`);
  }
  return value.trim();
}

function baseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('FORGEAX_KINO_BASE_URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configurationError('FORGEAX_KINO_BASE_URL must use http or https');
  }
  return new URL(`${url.toString().replace(/\/+$/u, '')}/api/v1/kino/`);
}

function outputOrigins(value: string): string[] {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    throw configurationError('FORGEAX_KINO_OUTPUT_ORIGINS must contain at least one origin');
  }
  try {
    return origins.map((origin) => {
      const parsed = new URL(origin);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('origin');
      }
      return parsed.origin;
    });
  } catch {
    throw configurationError('FORGEAX_KINO_OUTPUT_ORIGINS contains an invalid origin');
  }
}

function decodeNamespaceSecret(value: string): Uint8Array {
  const normalized = value.trim();
  const decoded = /^[0-9a-f]+$/iu.test(normalized) && normalized.length % 2 === 0
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64url');
  if (decoded.length < 32) {
    throw configurationError('FORGEAX_KINO_NAMESPACE_SECRET must decode to at least 32 bytes');
  }
  return new Uint8Array(decoded);
}

function scopedGameId(namespaceSecret: Uint8Array, installationId: string, localGameId: string): string {
  if (localGameId.length === 0) {
    throw new WorkbenchError({
      code: 'service_scope_invalid',
      target: 'service.arrival-kino',
      message: 'ForgeaX game id must not be empty',
      retryable: false,
    });
  }
  const digest = createHmac('sha256', namespaceSecret)
    .update(installationId)
    .update('\0')
    .update(localGameId)
    .digest('hex');
  return `fx_${digest}`;
}

/**
 * Creates the product-owned service-account binding used by both ForgeaX
 * workbench extensions. Credentials remain inside this binding and are never
 * projected to browser-facing contexts or durable generation receipts.
 */
export async function createRemoteKinoBinding(
  options: RemoteKinoBindingOptions,
): Promise<ServiceBinding> {
  const env = environment(options);
  const kinoBaseUrl = baseUrl(required(env.FORGEAX_KINO_BASE_URL, 'FORGEAX_KINO_BASE_URL'));
  const gatewayToken = required(env.FORGEAX_KINO_GATEWAY_TOKEN, 'FORGEAX_KINO_GATEWAY_TOKEN');
  const namespaceSecret = decodeNamespaceSecret(
    required(env.FORGEAX_KINO_NAMESPACE_SECRET, 'FORGEAX_KINO_NAMESPACE_SECRET'),
  );
  const origins = outputOrigins(required(env.FORGEAX_KINO_OUTPUT_ORIGINS, 'FORGEAX_KINO_OUTPUT_ORIGINS'));
  const installationId = options.installationId ?? await getOrCreateKinoInstallationId(options.projectRoot);

  return createKinoServiceBinding({
    baseUrl: kinoBaseUrl,
    outputOrigins: origins,
    scope: async (gameId) => scopedGameId(namespaceSecret, installationId, gameId),
    headers: async () => ({ 'X-Gateway-Token': gatewayToken }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export function forgeaxKinoScope(
  namespaceSecret: Uint8Array,
  installationId: string,
  localGameId: string,
): string {
  return scopedGameId(namespaceSecret, installationId, localGameId);
}
