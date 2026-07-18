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

async function relayEval(code: string, deps: EditorGatewayHostToolsDeps): Promise<unknown> {
  const base = (deps.bridgeUrl ?? process.env.FORGEAX_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    const response = await fetchFn(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { unavailable: true, reason: `editor gateway relay returned HTTP ${response.status}` };
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) {
      return { unavailable: true, reason: 'editor gateway relay returned an invalid response' };
    }
    const result = envelope as { ok: unknown; value?: unknown };
    return result.ok === true ? result.value : envelope;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { unavailable: true, reason: `editor gateway relay unavailable: ${reason}` };
  }
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
