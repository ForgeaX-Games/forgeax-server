import { Hono } from 'hono';
import type { ServerWebSocket } from 'bun';

export const EDITOR_TRANSPORT_WS_SID = '__editor_transport__';
export const EDITOR_TRANSPORT_VERSION = 'editor-transport/v1';

type JsonRecord = Record<string, unknown>;

interface EditorTransportSocketData {
  readonly sid?: string;
}

interface PendingRequest {
  readonly request: JsonRecord;
  readonly socket: ServerWebSocket<EditorTransportSocketData>;
  readonly scope: string;
  readonly resolve: (response: JsonRecord) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type EditorTransportRole = 'interactive' | 'managed';
type EditorTransportVisibility = 'visible' | 'hidden';

interface EditorTransportPresence {
  readonly visibility: EditorTransportVisibility;
  readonly focused: boolean;
  readonly engaged: boolean;
  readonly activity: number;
}

export interface EditorTransportCarrierOptions {
  readonly timeoutMs?: number;
  /** Briefly wait for a user-owned page to reconnect before creating a managed fallback. */
  readonly managedFallbackDelayMs?: number;
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
  readonly dispatch: (request: JsonRecord) => Promise<JsonRecord>;
  readonly connected: () => boolean;
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

function unavailable(request: JsonRecord, hint: string): JsonRecord {
  return {
    jsonrpc: '2.0',
    version: EDITOR_TRANSPORT_VERSION,
    id: request.id,
    correlationId: request.correlationId,
    error: {
      code: 'editor-carrier-unavailable',
      hint,
      retryable: true,
      recoveryActions: ['editor.discover', 'request.retry'],
    },
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

/**
 * Thin server-side carrier for the public Editor transport.
 *
 * The server owns neither the editor Gateway nor a document/world replica. A
 * live Studio page registers over WebSocket, executes the typed request in its
 * in-process Editor realm, and returns the same versioned response. The HTTP
 * route is the stable door for browser clients and host tools.
 */
export function createEditorTransportCarrier(options: EditorTransportCarrierOptions = {}): EditorTransportCarrier {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const managedFallbackDelayMs = options.managedFallbackDelayMs ?? 250;
  const app = new Hono();
  const pending = new Map<string, PendingRequest>();
  const connectionScopes = new Map<ServerWebSocket<EditorTransportSocketData>, string | null>();
  const connectionRoles = new Map<ServerWebSocket<EditorTransportSocketData>, EditorTransportRole | null>();
  const connectionPresence = new Map<ServerWebSocket<EditorTransportSocketData>, EditorTransportPresence>();
  const socketsByScope = new Map<string, Set<ServerWebSocket<EditorTransportSocketData>>>();
  const deferredInteractiveAuthority = new Set<string>();
  let activitySequence = 0;

  const publishInteractiveAuthorityIfIdle = (scope: string): void => {
    if (!deferredInteractiveAuthority.has(scope) || options.onInteractiveAuthority === undefined) return;
    const managedRequestInFlight = [...pending.values()].some((entry) => (
      entry.scope === scope && connectionRoles.get(entry.socket) === 'managed'
    ));
    if (managedRequestInFlight) return;
    deferredInteractiveAuthority.delete(scope);
    void Promise.resolve(options.onInteractiveAuthority(scope)).catch((error) => {
      console.warn('[editor-transport] failed to retire redundant managed carrier:', error);
    });
  };

  const markInteractiveAuthority = (scope: string): void => {
    if (options.onInteractiveAuthority === undefined) return;
    deferredInteractiveAuthority.add(scope);
    publishInteractiveAuthorityIfIdle(scope);
  };

  const presenceFrom = (value: JsonRecord): EditorTransportPresence | null => {
    if ((value.visibility !== 'visible' && value.visibility !== 'hidden') || typeof value.focused !== 'boolean') return null;
    return {
      visibility: value.visibility,
      focused: value.focused,
      engaged: value.engaged === true,
      activity: ++activitySequence,
    };
  };

  const priorityOf = (socket: ServerWebSocket<EditorTransportSocketData>): readonly [number, number] => {
    const role = connectionRoles.get(socket);
    const presence = connectionPresence.get(socket);
    if (role === 'interactive') {
      if (presence?.focused && presence.engaged) return [5, presence.activity];
      if (presence?.focused) return [4, presence.activity];
      if (presence?.visibility === 'visible' && presence.engaged) return [3, presence.activity];
      if (presence?.visibility === 'visible') return [2, presence.activity];
      if (presence?.engaged) return [1, presence.activity];
      return [0, presence?.activity ?? 0];
    }
    return [-1, presence?.activity ?? 0];
  };

  const activeSocket = (scope: string): ServerWebSocket<EditorTransportSocketData> | undefined => {
    const group = socketsByScope.get(scope);
    if (group === undefined) return undefined;
    let selected: ServerWebSocket<EditorTransportSocketData> | undefined;
    let selectedPriority: readonly [number, number] = [-1, -1];
    for (const socket of group) {
      if (socket.readyState === 1) {
        const priority = priorityOf(socket);
        if (priority[0] > selectedPriority[0] || (priority[0] === selectedPriority[0] && priority[1] > selectedPriority[1])) {
          selected = socket;
          selectedPriority = priority;
        }
      }
      else group.delete(socket);
    }
    if (group.size === 0) socketsByScope.delete(scope);
    return selected;
  };

  const failPending = (socket: ServerWebSocket<EditorTransportSocketData>, hint: string): void => {
    const settledScopes = new Set<string>();
    for (const [key, entry] of pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      pending.delete(key);
      settledScopes.add(entry.scope);
      entry.resolve(unavailable(entry.request, hint));
    }
    for (const scope of settledScopes) publishInteractiveAuthorityIfIdle(scope);
  };

  const acquireSocket = async (scope: string): Promise<ServerWebSocket<EditorTransportSocketData> | undefined> => {
    const connected = activeSocket(scope);
    if (connected !== undefined || options.ensureScope === undefined) return connected;
    const fallbackAt = Date.now() + Math.max(0, Math.min(managedFallbackDelayMs, timeoutMs));
    while (Date.now() < fallbackAt) {
      const reconnected = activeSocket(scope);
      if (reconnected !== undefined) return reconnected;
      await Bun.sleep(Math.min(25, fallbackAt - Date.now()));
    }
    try {
      await options.ensureScope(scope);
    } catch {
      return undefined;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = activeSocket(scope);
      if (ready !== undefined) return ready;
      await Bun.sleep(25);
    }
    return undefined;
  };

  const dispatch = async (request: JsonRecord): Promise<JsonRecord> => {
    const parsed = requestShape(request);
    if (parsed === null) return protocolError(isRecord(request) ? request : {});
    const scope = parsed.scope as string;
    const key = pendingKey(scope, parsed.id as string, parsed.correlationId as string);
    const target = await acquireSocket(scope);
    if (target === undefined) {
      return unavailable(parsed, `Connect or start a Studio Editor page for scope "${scope}" before using the Editor transport.`);
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
      const timer = setTimeout(() => {
        pending.delete(key);
        publishInteractiveAuthorityIfIdle(scope);
        resolve(unavailable(parsed, `The connected Studio editor page did not answer within ${timeoutMs}ms.`));
      }, timeoutMs);
      pending.set(key, { request: parsed, socket: target, scope, resolve, timer });
      try {
        target.send(JSON.stringify({ type: 'editor-transport/request', request: parsed }));
      } catch {
        clearTimeout(timer);
        pending.delete(key);
        publishInteractiveAuthorityIfIdle(scope);
        resolve(unavailable(parsed, 'The Studio editor transport connection closed while sending the request.'));
      }
    });
  };

  app.get('/api/editor/transport/health', (c) => c.json({
    ok: true,
    connected: [...socketsByScope.keys()].some((scope) => activeSocket(scope) !== undefined),
    scopes: [...socketsByScope.keys()].filter((scope) => activeSocket(scope) !== undefined).sort(),
    carriers: [...socketsByScope.entries()].map(([scope, sockets]) => {
      const selected = activeSocket(scope);
      return {
        scope,
        selected: selected === undefined ? null : {
          role: connectionRoles.get(selected),
          visibility: connectionPresence.get(selected)?.visibility ?? 'hidden',
          focused: connectionPresence.get(selected)?.focused ?? false,
          engaged: connectionPresence.get(selected)?.engaged ?? false,
        },
        candidates: [...sockets].filter((socket) => socket.readyState === 1).map((socket) => ({
          role: connectionRoles.get(socket),
          visibility: connectionPresence.get(socket)?.visibility ?? 'hidden',
          focused: connectionPresence.get(socket)?.focused ?? false,
          engaged: connectionPresence.get(socket)?.engaged ?? false,
        })),
      };
    }).sort((left, right) => left.scope.localeCompare(right.scope)),
    version: EDITOR_TRANSPORT_VERSION,
  }));

  app.post('/api/editor/transport', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonResponse(protocolError(), 400); }
    const parsed = requestShape(body);
    if (parsed === null) return jsonResponse(protocolError(isRecord(body) ? body : {}), 400);
    const result = await dispatch(parsed);
    const status = result.error && (result.error as JsonRecord).code === 'editor-carrier-unavailable' ? 503 : 200;
    return jsonResponse(result, status);
  });

  const isSocket = (socket: ServerWebSocket<EditorTransportSocketData>): boolean => socket.data.sid === EDITOR_TRANSPORT_WS_SID;

  const open = (socket: ServerWebSocket<EditorTransportSocketData>): void => {
    if (!isSocket(socket)) return;
    connectionScopes.set(socket, null);
    connectionRoles.set(socket, null);
    connectionPresence.set(socket, { visibility: 'hidden', focused: false, engaged: false, activity: ++activitySequence });
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
      if (!connectionScopes.has(socket)) return;
      const previousScope = connectionScopes.get(socket);
      if (previousScope === undefined) return;
      if (previousScope !== null && previousScope !== value.scope) {
        const previousGroup = socketsByScope.get(previousScope);
        previousGroup?.delete(socket);
        if (previousGroup?.size === 0) socketsByScope.delete(previousScope);
      }
      connectionScopes.set(socket, value.scope);
      connectionRoles.set(socket, value.role);
      const presence = presenceFrom(value);
      if (presence !== null) connectionPresence.set(socket, presence);
      const group = socketsByScope.get(value.scope) ?? new Set();
      group.delete(socket);
      group.add(socket);
      socketsByScope.set(value.scope, group);
      if (value.role === 'interactive') markInteractiveAuthority(value.scope);
      return;
    }
    if (value.type === 'editor-transport/presence') {
      const scope = connectionScopes.get(socket);
      const presence = presenceFrom(value);
      if (scope !== undefined && scope !== null && presence !== null) connectionPresence.set(socket, presence);
      return;
    }
    if (value.type !== 'editor-transport/response') return;
    const response = responseShape(value.response);
    if (response === null) return;
    const scope = connectionScopes.get(socket);
    if (scope === undefined || scope === null) return;
    const key = pendingKey(scope, response.id as string, response.correlationId as string);
    const entry = pending.get(key);
    if (entry === undefined || entry.socket !== socket || response.correlationId !== entry.request.correlationId) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    entry.resolve(response);
    publishInteractiveAuthorityIfIdle(scope);
  };

  const close = (socket: ServerWebSocket<EditorTransportSocketData>): void => {
    if (!isSocket(socket)) return;
    const scope = connectionScopes.get(socket);
    if (scope === undefined) return;
    connectionScopes.delete(socket);
    connectionRoles.delete(socket);
    connectionPresence.delete(socket);
    if (scope !== null) {
      const group = socketsByScope.get(scope);
      group?.delete(socket);
      if (group?.size === 0) socketsByScope.delete(scope);
    }
    failPending(socket, `The Editor page for scope "${scope ?? 'unregistered'}" disconnected; retry after it is ready.`);
  };

  return {
    app, open, message, close, isSocket, dispatch,
    connected: () => [...socketsByScope.keys()].some((scope) => activeSocket(scope) !== undefined),
  };
}
