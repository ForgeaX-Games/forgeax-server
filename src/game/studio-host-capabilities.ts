export interface StudioHostCapabilities {
  readonly editorRelay: {
    readonly available: boolean;
    readonly baseUrl?: string;
    readonly reason: 'available' | 'not-configured' | 'invalid-url' | 'unhealthy' | 'invalid-health';
  };
}

export const DEFAULT_STUDIO_HOST_CAPABILITIES: StudioHostCapabilities = Object.freeze({
  editorRelay: Object.freeze({ available: false, reason: 'not-configured' }),
});

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ResolveStudioHostCapabilitiesOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

function explicitLoopbackRelayUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== '') return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the product capability once at boot. Relay-backed tools are exposed
 * only when Studio explicitly projected a loopback URL and that peer answered
 * its health contract; every missing, malformed, or unhealthy state fails
 * closed while the typed editor_transport capability remains independent.
 */
export async function resolveStudioHostCapabilities(
  options: ResolveStudioHostCapabilitiesOptions = {},
): Promise<StudioHostCapabilities> {
  const configured = options.env?.FORGEAX_EDITOR_RELAY_URL
    ?? process.env.FORGEAX_EDITOR_RELAY_URL;
  if (!configured?.trim()) return DEFAULT_STUDIO_HOST_CAPABILITIES;

  const baseUrl = explicitLoopbackRelayUrl(configured);
  if (!baseUrl) {
    return { editorRelay: { available: false, reason: 'invalid-url' } };
  }

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
  } catch {
    return { editorRelay: { available: false, baseUrl, reason: 'unhealthy' } };
  }
  if (!response.ok) {
    return { editorRelay: { available: false, baseUrl, reason: 'unhealthy' } };
  }
  try {
    const health = await response.json() as { pageConnected?: unknown };
    if (typeof health.pageConnected !== 'boolean') {
      return { editorRelay: { available: false, baseUrl, reason: 'invalid-health' } };
    }
  } catch {
    return { editorRelay: { available: false, baseUrl, reason: 'invalid-health' } };
  }
  return { editorRelay: { available: true, baseUrl, reason: 'available' } };
}
