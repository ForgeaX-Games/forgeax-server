/** Live editor gateway host tools.
 *
 * Studio owns the editor-specific transport: the CLI only sees HostToolSpec
 * registrations and continues to apply its existing persona allow-list and
 * trust gate. The relay is DEV-only and loopback-only. The AI-facing surface
 * deliberately exposes the editor's generic eval capability as one explicit
 * tool: the gateway skill owns the code contract, while this host tool owns
 * the transport and session trust boundary.
 */
import type { HostToolSpec } from '@forgeax/orchestrator/orchestration-seams';

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

/** Resolve the relay base URL the same way every leg of the transport does. */
export function relayBaseUrl(deps: EditorGatewayHostToolsDeps): string {
  return (deps.bridgeUrl ?? process.env.FORGEAX_BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '');
}

export async function relayEval(
  code: string,
  deps: EditorGatewayHostToolsDeps,
  timeoutMs = 30_000,
): Promise<unknown> {
  const base = relayBaseUrl(deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(timeoutMs),
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

/** Register the direct code-execution surface for a live editor gateway. */
export function editorGatewayHostTools(deps: EditorGatewayHostToolsDeps = {}): HostToolSpec[] {
  if (process.env.FORGEAX_DISABLE_EDITOR_EVAL === '1') return [];
  return [
    {
      name: 'editor_gateway_eval',
      description:
        'LOW-LEVEL ESCAPE HATCH for running JavaScript in the already-connected ForgeaX editor gateway page. NOT the routine path: inspection, navigation and supported edits go through editor_ui_browse, which walks the same doors a human uses and reports measured visibility. Reach for this tool only when editor_ui_browse demonstrably cannot do the job AND you can quote the specific failure you hit on THIS task — a remembered defect is not evidence. It is still far better than Bash, gateway-live.mjs or probing localhost by hand, so if you do need low-level access, use this rather than those. Pass the code as the `code` argument; call `gateway.listOps()` inside the code for discovery.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript expression or program evaluated in the live editor gateway page.',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      run: async (args) => {
        if (typeof args.code !== 'string' || !args.code.trim()) {
          return { ok: false, error: { code: 'INVALID_ARGS', hint: 'editor_gateway_eval requires a non-empty string "code"' } };
        }
        return await relayEval(args.code, deps);
      },
    },
  ];
}
