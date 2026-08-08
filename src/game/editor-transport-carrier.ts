import { Hono } from 'hono';
import type { ServerWebSocket } from 'bun';

export const EDITOR_TRANSPORT_WS_SID = '__editor_transport__';
export const EDITOR_TRANSPORT_VERSION = 'editor-transport/v1';
export const DEFAULT_EDITOR_TRANSPORT_TIMEOUT_MS = 60_000;
export const MAX_EDITOR_TRANSPORT_TIMEOUT_MS = 300_000;

type JsonRecord = Record<string, unknown>;

interface EditorTransportSocketData { readonly sid?: string }

interface PendingRequest {
  readonly request: JsonRecord;
  readonly socket: ServerWebSocket<EditorTransportSocketData>;
  readonly scope: string;
  readonly resolve: (response: JsonRecord) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type EditorTransportRole = 'interactive' | 'managed';
type EditorTransportVisibility = 'visible' | 'hidden';

interface EditorTransportPresence { readonly visibility: EditorTransportVisibility; readonly focused: boolean; readonly gameplay: boolean }

interface EditorTransportConnection { readonly scope: string | null; readonly role: EditorTransportRole | null; readonly presence: EditorTransportPresence }

interface EditorTransportDispatchOptions {
  /** Preserve the managed carrier fallback for explicit host operations; passive projections opt out. */
  readonly allowCarrierProvisioning?: boolean;
}

export interface EditorTransportCarrierOptions {
  /** Default request deadline; callers may request a shorter or longer bounded deadline. */
  readonly timeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly ensureScope?: (scope: string) => Promise<void>;
  /** Called once an interactive page owns the scope and managed in-flight work is drained. */
  readonly onInteractiveAuthority?: (scope: string) => void | Promise<void>;
}

export interface EditorTransportCarrier {
  readonly app: Hono;
  readonly open: (socket: ServerWebSocket<EditorTransportSocketData>) => void;
  readonly message: (socket: ServerWebSocket<EditorTransportSocketData>, message: unknown) => void;
  readonly close: (socket: ServerWebSocket<EditorTransportSocketData>) => void;
  readonly isSocket: (socket: ServerWebSocket<EditorTransportSocketData>) => boolean;
  readonly dispatch: (request: JsonRecord, options?: EditorTransportDispatchOptions) => Promise<JsonRecord>;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonResponse(value: JsonRecord, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requestShape(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.jsonrpc !== '2.0'
    || value.version !== EDITOR_TRANSPORT_VERSION
    || typeof value.id !== 'string'
    || typeof value.correlationId !== 'string'
    || typeof value.scope !== 'string'
    || value.scope.length === 0
    || typeof value.method !== 'string'
    || !Object.prototype.hasOwnProperty.call(value, 'params')
  ) return null;
  return value;
}

function carrierError(
  request: JsonRecord, code: string, hint: string,
  recoveryActions = ['editor.discover', 'request.retry'], details: JsonRecord = {},
): JsonRecord {
  return {
    jsonrpc: '2.0',
    version: EDITOR_TRANSPORT_VERSION,
    id: request.id,
    correlationId: request.correlationId,
    error: { code, hint, retryable: true, recoveryActions, ...details },
  };
}

function protocolError(request: Partial<JsonRecord> = {}): JsonRecord {
  return {
    jsonrpc: '2.0',
    version: EDITOR_TRANSPORT_VERSION,
    id: typeof request.id === 'string' ? request.id : 'invalid',
    correlationId: typeof request.correlationId === 'string' ? request.correlationId : 'invalid',
    error: {
      code: 'protocol-invalid-message',
      hint: 'The editor transport request does not match editor-transport/v1.',
      retryable: false,
      recoveryActions: ['editor.discover'],
    },
  };
}

function responseShape(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.jsonrpc !== '2.0'
    || value.version !== EDITOR_TRANSPORT_VERSION
    || typeof value.id !== 'string'
    || typeof value.correlationId !== 'string'
    || (Object.prototype.hasOwnProperty.call(value, 'result') === Object.prototype.hasOwnProperty.call(value, 'error'))
  ) return null;
  return value;
}

function pendingKey(scope: string, id: string, correlationId: string): string {
  return JSON.stringify([scope, id, correlationId]);
}

function boundedTimeout(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return Math.min(fallback, maximum);
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

/**
 * Thin server-side carrier for the public Editor transport.
 *
 * The server owns neither the editor Gateway nor a document/world replica. A
 * live Studio page registers over WebSocket, executes the typed request in its
 * in-process Editor realm, and returns the same versioned response. The HTTP
 * route is the stable door for browser clients and host tools.
 */
export function createEditorTransportCarrier(options: EditorTransportCarrierOptions = {}): EditorTransportCarrier {
  const maxTimeoutMs = boundedTimeout(options.maxTimeoutMs, MAX_EDITOR_TRANSPORT_TIMEOUT_MS, MAX_EDITOR_TRANSPORT_TIMEOUT_MS);
  const defaultTimeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_EDITOR_TRANSPORT_TIMEOUT_MS, maxTimeoutMs);
  const app = new Hono();
  const pending = new Map<string, PendingRequest>();
  const connections = new Map<ServerWebSocket<EditorTransportSocketData>, EditorTransportConnection>();
  const scopeConnections = (scope: string) => [...connections].filter(([socket, connection]) => socket.readyState === 1 && connection.scope === scope);

  const maybeRetireManaged = (scope: string): void => {
    if (!scopeConnections(scope).some(([, connection]) => connection.role === 'interactive' && connection.presence.gameplay)) return;
    if ([...pending.values()].some((entry) => (
      entry.scope === scope && connections.get(entry.socket)?.role === 'managed'
    ))) return;
    if (options.onInteractiveAuthority === undefined) return;
    void Promise.resolve(options.onInteractiveAuthority(scope)).catch((error) => {
      console.warn('[editor-transport] failed to retire redundant managed carrier:', error);
    });
  };

  const presenceFrom = (value: JsonRecord): EditorTransportPresence | null => {
    if ((value.visibility !== 'visible' && value.visibility !== 'hidden') || typeof value.focused !== 'boolean') return null;
    const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
    return {
      visibility: value.visibility,
      focused: value.focused,
      gameplay: capabilities.gameplay === true,
    };
  };

  /** null means indistinguishable interactive pages; undefined means no eligible carrier. */
  const activeSocket = (scope: string, gameplay = false): ServerWebSocket<EditorTransportSocketData> | null | undefined => {
    const live = scopeConnections(scope);
    const interactive = live.filter(([, connection]) => connection.role === 'interactive');
    const pool = interactive.length > 0 ? interactive : live.filter(([, connection]) => connection.role === 'managed');
    const eligible = gameplay ? pool.filter(([, connection]) => connection.presence.gameplay) : pool;
    if (eligible.length === 0) return undefined;
    if (interactive.length === 0) return eligible.at(-1)?.[0];
    const focused = eligible.filter(([, connection]) => connection.presence.focused);
    if (focused.length === 1) return focused[0]![0];
    const visible = eligible.filter(([, connection]) => connection.presence.visibility === 'visible');
    if (focused.length === 0 && visible.length === 1) return visible[0]![0];
    return eligible.length === 1 ? eligible[0]![0] : null;
  };

  const failPending = (socket: ServerWebSocket<EditorTransportSocketData>, hint: string): void => {
    const settledScopes = new Set<string>();
    for (const [key, entry] of pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      pending.delete(key);
      settledScopes.add(entry.scope);
      entry.resolve(carrierError(entry.request, 'editor-carrier-unavailable', hint));
    }
    for (const scope of settledScopes) maybeRetireManaged(scope);
  };

  const acquireSocket = async (
    scope: string,
    gameplay: boolean,
    allowCarrierProvisioning: boolean,
    deadline: number,
  ): Promise<ServerWebSocket<EditorTransportSocketData> | null | undefined> => {
    const connected = activeSocket(scope, gameplay);
    const hasLiveCarrier = scopeConnections(scope).length > 0;
    if (connected !== undefined || hasLiveCarrier || !allowCarrierProvisioning || options.ensureScope === undefined) return connected;
    try {
      await Promise.race([
        options.ensureScope(scope),
        Bun.sleep(Math.max(0, deadline - Date.now())),
      ]);
    } catch {
      return undefined;
    }
    while (Date.now() < deadline) {
      const ready = activeSocket(scope, gameplay);
      if (ready !== undefined) return ready;
      await Bun.sleep(Math.min(25, deadline - Date.now()));
    }
    return undefined;
  };

  const dispatch = async (
    request: JsonRecord,
    dispatchOptions: EditorTransportDispatchOptions = {},
  ): Promise<JsonRecord> => {
    const parsed = requestShape(request);
    if (parsed === null) return protocolError(isRecord(request) ? request : {});
    const scope = parsed.scope as string;
    const timeoutMs = boundedTimeout(parsed.timeoutMs, defaultTimeoutMs, maxTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const key = pendingKey(scope, parsed.id as string, parsed.correlationId as string);
    const target = await acquireSocket(scope, parsed.method === 'gameplay', dispatchOptions.allowCarrierProvisioning !== false, deadline);
    if (target === null) {
      return carrierError(parsed, 'editor-carrier-ambiguous', `Multiple equally authoritative Studio pages can answer scope "${scope}"; engage the intended page.`, ['editor.focus', 'request.retry']);
    }
    if (target === undefined) {
      return carrierError(parsed, 'editor-carrier-unavailable', `Connect or start a Studio Editor page for scope "${scope}" before using the Editor transport.`);
    }
    if (pending.has(key)) {
      return {
        ...protocolError(parsed),
        error: {
          code: 'request-duplicate',
          hint: `Editor transport request id "${parsed.id as string}" is already in flight.`,
          retryable: true,
          recoveryActions: ['run.get', 'request.retry'],
        },
      };
    }
    return new Promise<JsonRecord>((resolve) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => {
        pending.delete(key);
        maybeRetireManaged(scope);
        resolve(carrierError(
          parsed,
          'editor-carrier-timeout',
          `The selected Studio editor page did not answer within ${timeoutMs}ms. Its outcome is unknown and the operation may still be running; inspect state before any manual retry.`,
          [],
          { retryable: false, outcome: 'unknown', operationMayStillBeRunning: true },
        ));
      }, remainingMs);
      pending.set(key, { request: parsed, socket: target, scope, resolve, timer });
      try {
        target.send(JSON.stringify({ type: 'editor-transport/request', request: parsed }));
      } catch {
        clearTimeout(timer);
        pending.delete(key);
        maybeRetireManaged(scope);
        resolve(carrierError(parsed, 'editor-carrier-unavailable', 'The Studio editor transport connection closed while sending the request.'));
      }
    });
  };

  app.get('/api/editor/transport/health', (c) => {
    const carrierScopes = [...new Set([...connections].flatMap(([socket, connection]) => socket.readyState !== 1 || connection.scope === null ? [] : [connection.scope]))].sort();
    return c.json({
      ok: true,
      connected: carrierScopes.some((scope) => activeSocket(scope) != null),
      scopes: carrierScopes.filter((scope) => activeSocket(scope) != null),
      carriers: carrierScopes.map((scope) => {
        const selected = activeSocket(scope);
        const role = selected ? connections.get(selected)?.role : null;
        return {
          scope,
          authority: role === 'interactive' ? 'interactive' : role === 'managed' ? 'fallback' : 'unavailable',
          selected: selected == null ? null : {
            role,
            visibility: connections.get(selected)?.presence.visibility ?? 'hidden',
            focused: connections.get(selected)?.presence.focused ?? false,
            capabilities: { gameplay: connections.get(selected)?.presence.gameplay ?? false },
          },
          candidates: scopeConnections(scope).map(([, connection]) => ({
            role: connection.role,
            visibility: connection.presence.visibility,
            focused: connection.presence.focused,
            capabilities: { gameplay: connection.presence.gameplay },
          })),
        };
      }),
      version: EDITOR_TRANSPORT_VERSION,
    });
  });

  app.post('/api/editor/transport', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonResponse(protocolError(), 400); }
    const parsed = requestShape(body);
    if (parsed === null) return jsonResponse(protocolError(isRecord(body) ? body : {}), 400);
    const result = await dispatch(parsed, {
      allowCarrierProvisioning: c.req.header('x-forgeax-editor-carrier-provisioning') !== '0',
    });
    const code = result.error && (result.error as JsonRecord).code;
    const status = code === 'editor-carrier-timeout' ? 504 : typeof code === 'string' && code.startsWith('editor-carrier-') ? 503 : 200;
    return jsonResponse(result, status);
  });

  const isSocket = (socket: ServerWebSocket<EditorTransportSocketData>): boolean => socket.data.sid === EDITOR_TRANSPORT_WS_SID;

  const open = (socket: ServerWebSocket<EditorTransportSocketData>): void => {
    if (!isSocket(socket)) return;
    connections.set(socket, {
      scope: null, role: null,
      presence: { visibility: 'hidden', focused: false, gameplay: false },
    });
    socket.send(JSON.stringify({ type: 'editor-transport/hello', version: EDITOR_TRANSPORT_VERSION }));
  };

  const message = (socket: ServerWebSocket<EditorTransportSocketData>, messageValue: unknown): void => {
    if (!isSocket(socket)) return;
    let value: unknown;
    try { value = JSON.parse(String(messageValue)); } catch { return; }
    if (!isRecord(value)) return;
    if (value.type === 'editor-transport/ready') {
      if (
        value.version !== EDITOR_TRANSPORT_VERSION
        || (value.role !== 'interactive' && value.role !== 'managed')
        || typeof value.scope !== 'string'
        || value.scope.length === 0
      ) return;
      const connection = connections.get(socket);
      if (connection === undefined) return;
      const presence = presenceFrom(value);
      connections.set(socket, { scope: value.scope, role: value.role, presence: presence ?? connection.presence });
      maybeRetireManaged(value.scope);
      return;
    }
    if (value.type === 'editor-transport/presence') {
      const connection = connections.get(socket);
      const presence = presenceFrom(value);
      if (connection !== undefined && connection.scope !== null && presence !== null) {
        connections.set(socket, { ...connection, presence });
        if (!connection.presence.gameplay && presence.gameplay) maybeRetireManaged(connection.scope);
      }
      return;
    }
    if (value.type !== 'editor-transport/response') return;
    const response = responseShape(value.response);
    if (response === null) return;
    const scope = connections.get(socket)?.scope;
    if (scope === undefined || scope === null) return;
    const key = pendingKey(scope, response.id as string, response.correlationId as string);
    const entry = pending.get(key);
    if (entry === undefined || entry.socket !== socket || response.correlationId !== entry.request.correlationId) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    entry.resolve(response);
    maybeRetireManaged(scope);
  };

  const close = (socket: ServerWebSocket<EditorTransportSocketData>): void => {
    if (!isSocket(socket)) return;
    const scope = connections.get(socket)?.scope;
    if (scope === undefined) return;
    connections.delete(socket);
    failPending(socket, `The Editor page for scope "${scope ?? 'unregistered'}" disconnected; retry after it is ready.`);
  };

  return { app, open, message, close, isSocket, dispatch };
}
