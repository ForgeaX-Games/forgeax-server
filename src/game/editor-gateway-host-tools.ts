/** Live editor gateway host tools.
 *
 * Studio owns the editor-specific transport: the CLI only sees HostToolSpec
 * registrations and continues to apply its existing persona allow-list and
 * trust gate. The relay is DEV-only and loopback-only; this module deliberately
 * exposes two fixed gateway calls rather than a generic eval capability.
 */
import type { HostToolSpec } from 'forgeax-cli/orchestration-seams';

/** Only the callable fetch surface the relay adapter needs. Bun's global fetch
 * also carries `preconnect`, which test doubles intentionally do not implement. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EditorGatewayHostToolsDeps {
  bridgeUrl?: string;
  fetch?: FetchLike;
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:15295';

type GatewayFailure = { ok: false; error: { code: string; hint: string } };

function gatewayFailure(code: string, hint: string): GatewayFailure {
  return { ok: false, error: { code, hint } };
}

async function relayEval(code: string, deps: EditorGatewayHostToolsDeps): Promise<unknown> {
  const base = (deps.bridgeUrl ?? process.env.FORGEAX_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return gatewayFailure('RELAY_UNAVAILABLE', `editor gateway relay unavailable: ${reason}`);
  }
  if (!response.ok) {
    return gatewayFailure('RELAY_HTTP_ERROR', `editor gateway relay returned HTTP ${response.status}`);
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return gatewayFailure('RELAY_INVALID_RESPONSE', 'editor gateway relay returned an invalid response');
  }
  if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) {
    return gatewayFailure('RELAY_INVALID_RESPONSE', 'editor gateway relay returned an invalid response');
  }
  const result = envelope as { ok: unknown; value?: unknown; error?: unknown };
  if (result.ok === true) return result.value;
  if (
    result.ok === false
    && result.error
    && typeof result.error === 'object'
    && 'code' in result.error
    && 'hint' in result.error
    && typeof result.error.code === 'string'
    && typeof result.error.hint === 'string'
  ) {
    return envelope;
  }
  return gatewayFailure('RELAY_INVALID_RESPONSE', 'editor gateway relay returned an invalid response');
}

/** Register the narrow, auditable CLI surface for a live editor gateway. */
export function editorGatewayHostTools(deps: EditorGatewayHostToolsDeps = {}): HostToolSpec[] {
  return [
    {
      name: 'editor_gateway_list_ops',
      description: 'List the operations currently exposed by the live ForgeaX editor gateway, including their argument schemas and domains.',
      inputSchema: { type: 'object', properties: {} },
      run: () => relayEval('gateway.listOps()', deps),
    },
    {
      name: 'editor_gateway_dispatch',
      description: 'Dispatch one listed ForgeaX editor operation as the AI actor. Use editor_gateway_list_ops first to discover the operation schema.',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string' } },
        required: ['kind'],
        additionalProperties: true,
      },
      run: (args) => {
        if (typeof args.kind !== 'string' || !args.kind) {
          return { ok: false, error: { code: 'INVALID_ARGS', hint: 'editor_gateway_dispatch requires a non-empty string "kind"' } };
        }
        try {
          return relayEval(`gateway.dispatch(${JSON.stringify(args)}, 'ai')`, deps);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, error: { code: 'INVALID_ARGS', hint: `operation arguments are not serializable: ${reason}` } };
        }
      },
    },
  ];
}
