import type { HostToolRunCtx } from '@forgeax/orchestrator/seams';

type Value = Record<string, unknown>;
const record = (value: unknown): Value | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined;
export interface RuntimeFailureFeedback {
  readonly context: HostToolRunCtx;
  readonly correlationId: string;
  readonly receivedAt: number;
  readonly payload: Value;
}
interface Binding {
  socket: object;
  correlationId: string;
  context: HostToolRunCtx;
  identity?: string;
  failed: boolean;
}

/** Binds page-produced failure facts to the original trusted host-tool caller.
 * HTTP callers and page selection never supply a kernel recipient. */
export class EditorRuntimeFeedback {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, Map<string, Binding>>();
  constructor(private readonly receive: (feedback: RuntimeFailureFeedback) => void) {}

  dispatch(socket: object, request: Value, context?: HostToolRunCtx): void {
    const params = record(request.params);
    if (request.method !== 'run.dispatch' || !['editor.play', 'editor.stop'].includes(String(params?.operationId))) return;
    const scope = String(request.scope);
    // Repeated Play can return the existing run without producing a new page.
    // Keep its original owner until a new producer identity actually arrives.
    if (params?.operationId === 'editor.stop' || !context) {
      this.pending.delete(scope);
      this.bindings.delete(scope);
    }
    if (params?.operationId !== 'editor.play' || !context?.sid || !context.game || !context.agentId
      || scope !== `game:${context.game}` || typeof request.correlationId !== 'string') return;
    const pending = this.pending.get(scope) ?? new Map<string, Binding>();
    // Keep the original entering-play request when a repeat shares its completion.
    // Bound unresolved requests without evicting the oldest real attempt.
    if (pending.size >= 50 || pending.has(request.correlationId)) return;
    pending.set(request.correlationId, { socket, correlationId: request.correlationId, context: { ...context }, failed: false });
    this.pending.set(scope, pending);
  }

  message(socket: object, scope: string, envelope: Value): boolean {
    if (envelope.type !== 'editor-transport/runtime-event' || envelope.version !== 'editor-transport/v1') return false;
    const active = this.bindings.get(scope), pending = this.pending.get(scope)?.get(String(envelope.correlationId));
    const binding = active?.correlationId === envelope.correlationId ? active : pending;
    if (!binding || binding.socket !== socket || binding.failed || envelope.correlationId !== binding.correlationId) return false;
    const event = record(envelope.event), payload = record(event?.payload), eventScope = record(payload?.scope);
    if (!payload || payload.version !== 1 || !['VAG_CARRIER_HANDSHAKE', 'VAG_CARRIER_HEARTBEAT', 'VAG_CARRIER_FAILURE'].includes(String(event?.type))
      || eventScope?.projectId !== binding.context.projectRoot || eventScope?.gameId !== binding.context.game
      || typeof payload.pageNonce !== 'string' || !payload.pageNonce || payload.pageNonce.length > 256
      || typeof payload.runtimeId !== 'string' || !payload.runtimeId || payload.runtimeId.length > 256
      || !Number.isSafeInteger(payload.runtimeGeneration) || Number(payload.runtimeGeneration) <= 0) return false;
    const identity = JSON.stringify([payload.runtimeId, payload.runtimeGeneration, payload.pageNonce]);
    if (binding.identity && binding.identity !== identity) return false;
    if (event?.type !== 'VAG_CARRIER_FAILURE') {
      binding.identity = identity;
      this.bindings.set(scope, binding);
      if (pending === binding) this.pending.delete(scope);
      return true;
    }
    const failure = record(payload.failure);
    if (!failure || typeof failure.code !== 'string' || !failure.code || failure.code.length > 256
      || typeof failure.at !== 'string' || !Number.isFinite(Date.parse(failure.at))
      || (typeof failure.hint !== 'string' && typeof failure.message !== 'string')) return false;
    binding.identity = identity;
    binding.failed = true;
    this.bindings.set(scope, binding);
    if (pending === binding) this.pending.delete(scope);
    this.receive({ context: binding.context, correlationId: binding.correlationId, receivedAt: Date.now(), payload });
    return true;
  }

  close(socket: object): void {
    for (const [scope, binding] of this.bindings) if (binding.socket === socket) this.bindings.delete(scope);
    for (const [scope, entries] of this.pending) {
      for (const [correlationId, binding] of entries) if (binding.socket === socket) entries.delete(correlationId);
      if (!entries.size) this.pending.delete(scope);
    }
  }
}

/** Uses the active execution route only; an idle failure remains queued until
 * the user resumes, avoiding a new autonomous task or model fallback. */
export function runtimeFailureEvent(
  { context, correlationId, receivedAt, payload }: RuntimeFailureFeedback,
  route?: { kernelId?: string; model?: string },
) {
  const failure = payload.failure as Record<string, unknown>;
  return {
    source: 'studio-runtime', type: 'runtime_feedback', to: context.agentId,
    // An active kernel receives a bounded steer through its existing queue.
    // Idle agents retain the fact for their next authorized turn, without
    // starting a paid task or selecting a different model automatically.
    handoff: route?.kernelId ? 'steer' as const : 'silent' as const,
    ts: receivedAt,
    payload: {
      ...route,
      content: JSON.stringify({
        kind: 'current-game-runtime-failure', game: context.game,
        runtimeId: payload.runtimeId, pageNonce: payload.pageNonce,
        correlationId, occurredAt: failure.at, receivedAt,
        code: String(failure.code).slice(0, 256),
        message: String(failure.message ?? failure.hint).slice(0, 2000),
        observationsInvalidated: true,
        diagnostics: runtimeDiagnostics(failure.diagnostics),
        inspect: 'editor_transport: discover; gameplay describe/query/capture when available',
        recovery: 'Use discovered Editor operations and their current prerequisites. A transport failure alone does not identify a game-code defect.',
      }),
    },
  };
}

/** The carrier's bounded public diagnostic projection; never forward arbitrary payload fields. */
function runtimeDiagnostics(value: unknown): Value[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    if (!entry || typeof entry.code !== 'string' || !entry.code || entry.code.length > 256) return [];
    const result: Value = { code: entry.code };
    for (const [key, limit] of [['hint', 2000], ['expected', 2000], ['actual', 2000], ['propertyPath', 4096], ['sourcePath', 4096], ['sourceKey', 4096]] as const) {
      if (typeof entry[key] === 'string' && entry[key].length <= limit) result[key] = entry[key];
    }
    for (const key of ['unusedDeclaredGuids', 'undeclaredReferencedGuids', 'undeclaredReadGuids', 'missingGuids'] as const) {
      const guids = entry[key];
      if (Array.isArray(guids) && guids.length <= 100
        && guids.every((guid) => typeof guid === 'string' && guid.length <= 128)) result[key] = guids;
    }
    if (Array.isArray(entry.unexpectedSourceKeys) && entry.unexpectedSourceKeys.length <= 100
      && entry.unexpectedSourceKeys.every((key) => typeof key === 'string' && key.length <= 4096)) result.unexpectedSourceKeys = entry.unexpectedSourceKeys;
    if (Array.isArray(entry.kindMismatches) && entry.kindMismatches.length <= 100) {
      result.kindMismatches = entry.kindMismatches.flatMap((value) => {
        const mismatch = record(value);
        if (!mismatch || typeof mismatch.sourceKey !== 'string' || mismatch.sourceKey.length > 4096
          || typeof mismatch.expected !== 'string' || mismatch.expected.length > 2000
          || typeof mismatch.actual !== 'string' || mismatch.actual.length > 2000) return [];
        return [{ sourceKey: mismatch.sourceKey, expected: mismatch.expected, actual: mismatch.actual }];
      });
    }
    return [result];
  });
}
