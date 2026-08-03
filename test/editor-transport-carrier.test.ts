import { describe, expect, test } from 'bun:test';
import {
  EDITOR_TRANSPORT_WS_SID,
  createEditorTransportCarrier,
} from '../src/game/editor-transport-carrier';

type FakeSocket = {
  data: { sid: string };
  readyState: number;
  sent: string[];
  send: (value: string) => void;
  close: () => void;
};

function socket(): FakeSocket {
  const value: FakeSocket = {
    data: { sid: EDITOR_TRANSPORT_WS_SID },
    readyState: 1,
    sent: [],
    send(message) { value.sent.push(message); },
    close() { value.readyState = 3; },
  };
  return value;
}

const request = {
  jsonrpc: '2.0',
  version: 'editor-transport/v1',
  id: 'request-1',
  correlationId: 'correlation-1',
  method: 'discover',
  params: { scope: 'game:spin-cube', actor: { id: 'studio-ui', kind: 'human' }, sessionId: 'studio-ui:spin-cube' },
};

describe('Studio editor typed transport carrier', () => {
  test('returns a structured unavailable response when no editor page is connected', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 10 });
    const response = await carrier.app.request('/api/editor/transport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      id: 'request-1',
      correlationId: 'correlation-1',
      error: {
        code: 'editor-carrier-unavailable',
        retryable: true,
        recoveryActions: ['editor.discover', 'request.retry'],
      },
    });
  });

  test('forwards a typed request to the connected page and preserves its correlation', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const page = socket();
    carrier.open(page as never);
    carrier.message(page as never, JSON.stringify({ type: 'editor-transport/ready', scope: 'game:spin-cube' }));

    const pending = carrier.app.request('/api/editor/transport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    await Bun.sleep(0);
    const wire = JSON.parse(page.sent.at(-1) ?? '{}') as { type?: string; request?: typeof request };
    expect(wire).toMatchObject({ type: 'editor-transport/request', request });

    carrier.message(page as never, JSON.stringify({
      type: 'editor-transport/response',
      response: {
        jsonrpc: '2.0',
        version: 'editor-transport/v1',
        id: request.id,
        correlationId: request.correlationId,
        result: { protocolVersion: 'editor-transport/v1' },
      },
    }));

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: request.id,
      correlationId: request.correlationId,
      result: { protocolVersion: 'editor-transport/v1' },
    });
  });
});
