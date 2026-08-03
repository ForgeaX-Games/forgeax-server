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
  readonly resolve: (response: JsonRecord) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface EditorTransportCarrierOptions {
  readonly timeoutMs?: number;
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
  const app = new Hono();
  const pending = new Map<string, PendingRequest>();
  let current: ServerWebSocket<EditorTransportSocketData> | null = null;
  let ready = false;

  const failPending = (hint: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve(unavailable(entry.request, hint));
    }
  };

  const dispatch = (request: JsonRecord): Promise<JsonRecord> => {
    const parsed = requestShape(request);
    if (parsed === null) return Promise.resolve(protocolError(isRecord(request) ? request : {}));
    if (current === null || !ready || current.readyState !== 1) {
      return Promise.resolve(unavailable(parsed, 'Connect a live Studio editor page before using the Editor transport.'));
    }
    if (pending.has(parsed.id as string)) {
      return Promise.resolve({
        ...protocolError(parsed),
        error: {
          code: 'request-duplicate',
          hint: `Editor transport request id "${parsed.id as string}" is already in flight.`,
          retryable: true,
          recoveryActions: ['run.get', 'request.retry'],
        },
      });
    }
    return new Promise<JsonRecord>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(parsed.id as string);
        resolve(unavailable(parsed, `The connected Studio editor page did not answer within ${timeoutMs}ms.`));
      }, timeoutMs);
      pending.set(parsed.id as string, { request: parsed, resolve, timer });
      try {
        current!.send(JSON.stringify({ type: 'editor-transport/request', request: parsed }));
      } catch {
        clearTimeout(timer);
        pending.delete(parsed.id as string);
        resolve(unavailable(parsed, 'The Studio editor transport connection closed while sending the request.'));
      }
    });
  };

  app.get('/api/editor/transport/health', (c) => c.json({
    ok: true,
    connected: current !== null && ready && current.readyState === 1,
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
    if (current !== null && current !== socket) {
      try { current.close(); } catch { /* the old page is already gone */ }
      failPending('The previous Studio editor transport page was replaced.');
    }
    current = socket;
    ready = false;
    socket.send(JSON.stringify({ type: 'editor-transport/hello', version: EDITOR_TRANSPORT_VERSION }));
  };

  const message = (socket: ServerWebSocket<EditorTransportSocketData>, messageValue: unknown): void => {
    if (!isSocket(socket)) return;
    let value: unknown;
    try { value = JSON.parse(String(messageValue)); } catch { return; }
    if (!isRecord(value)) return;
    if (value.type === 'editor-transport/ready') {
      if (current === socket) ready = true;
      return;
    }
    if (value.type !== 'editor-transport/response') return;
    const response = responseShape(value.response);
    if (response === null || current !== socket) return;
    const id = response.id as string;
    const entry = pending.get(id);
    if (entry === undefined || response.correlationId !== entry.request.correlationId) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(response);
  };

  const close = (socket: ServerWebSocket<EditorTransportSocketData>): void => {
    if (!isSocket(socket) || current !== socket) return;
    current = null;
    ready = false;
    failPending('The Studio editor transport page disconnected; retry after the page is ready.');
  };

  return { app, open, message, close, isSocket, dispatch, connected: () => current !== null && ready && current.readyState === 1 };
}
