/**
 * Access policy shared by browser-facing generative-visual routes.
 *
 * Local Studio and Tauri origins are allowed by default. Remote origins require
 * an explicit allowlist, and forwarded client addresses are ignored unless the
 * immediate proxy address is explicitly trusted.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'tauri.localhost']);
const BOUND_CONNECTION_ADDRESSES = new WeakMap<Request, string>();

export interface GenerativeVisualAccessPolicyOptions {
  readonly allowedOrigins?: readonly string[];
  readonly trustedProxy?: boolean;
  readonly trustedProxyAddresses?: readonly string[];
  readonly requireConnectionProvenance?: boolean;
}

export interface GenerativeVisualAccessPolicy {
  authorize(request: Request, connectionAddress?: string): { readonly ok: true } | {
    readonly ok: false;
    readonly status: 403;
    readonly error: string;
  };
  clientKey(request: Request, connectionAddress?: string): string;
}

function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (address === 'localhost' || address === '::1') return true;
  if (address.startsWith('127.')) return true;
  return address.startsWith('::ffff:127.');
}

function firstForwardedAddress(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first || undefined;
}

function configuredOrigins(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((origin) => normalizedOrigin(origin.trim()))
      .filter((origin): origin is string => origin !== undefined),
  );
}

function configuredBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function normalizedAddress(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function configuredAddresses(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((address) => normalizedAddress(address))
      .filter(Boolean),
  );
}

export function bindGenerativeVisualConnection(
  request: Request,
  connectionAddress: string | undefined,
): Request {
  const bound = new Request(request);
  if (connectionAddress?.trim()) {
    BOUND_CONNECTION_ADDRESSES.set(bound, connectionAddress.trim());
  }
  return bound;
}

export function createGenerativeVisualAccessPolicy(
  options: GenerativeVisualAccessPolicyOptions = {},
): GenerativeVisualAccessPolicy {
  const allowedOrigins = new Set(
    options.allowedOrigins
      ? options.allowedOrigins
        .map((origin) => normalizedOrigin(origin))
        .filter((origin): origin is string => origin !== undefined)
      : configuredOrigins(process.env.FORGEAX_VISUALS_ALLOWED_ORIGINS),
  );
  const trustedProxy = options.trustedProxy
    ?? configuredBoolean(process.env.FORGEAX_TRUSTED_PROXY);
  const trustedProxyAddresses = new Set(
    options.trustedProxyAddresses
      ? options.trustedProxyAddresses.map(normalizedAddress)
      : configuredAddresses(process.env.FORGEAX_TRUSTED_PROXY_ADDRESSES),
  );
  const requireConnectionProvenance = options.requireConnectionProvenance ?? true;

  function resolvedConnectionAddress(
    request: Request,
    explicitAddress: string | undefined,
  ): string | undefined {
    const connection = explicitAddress?.trim()
      || BOUND_CONNECTION_ADDRESSES.get(request)
      || undefined;
    if (
      trustedProxy
      && connection
      && trustedProxyAddresses.has(normalizedAddress(connection))
    ) {
      const forwarded = firstForwardedAddress(request.headers.get('x-forwarded-for'));
      if (forwarded) return forwarded;
    }
    return connection;
  }

  return {
    authorize(request, explicitAddress) {
      const origin = normalizedOrigin(request.headers.get('origin') ?? undefined);
      if (!origin) {
        return {
          ok: false,
          status: 403,
          error: 'trusted Studio origin required',
        };
      }
      if (!isLocalOrigin(origin) && !allowedOrigins.has(origin)) {
        return {
          ok: false,
          status: 403,
          error: 'local Studio origin required',
        };
      }

      const address = resolvedConnectionAddress(request, explicitAddress);
      if (!address && requireConnectionProvenance && !allowedOrigins.has(origin)) {
        return {
          ok: false,
          status: 403,
          error: 'connection provenance required',
        };
      }
      if (
        address
        && !isLoopbackAddress(address)
        && !allowedOrigins.has(origin)
      ) {
        return {
          ok: false,
          status: 403,
          error: 'local Studio connection required',
        };
      }
      return { ok: true };
    },

    clientKey(request, explicitAddress) {
      const origin = normalizedOrigin(request.headers.get('origin') ?? undefined)
        ?? 'unknown-origin';
      const address = resolvedConnectionAddress(request, explicitAddress) ?? 'direct';
      return `${origin}|${address}`;
    },
  };
}
