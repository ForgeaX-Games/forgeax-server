import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_EDITOR_TRANSPORT_TIMEOUT_MS,
  EDITOR_TRANSPORT_WS_SID,
  MAX_EDITOR_TRANSPORT_TIMEOUT_MS,
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
  scope: 'game:spin-cube',
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

  test('ensures a managed page before declaring the scoped carrier unavailable', async () => {
    let managed: FakeSocket | undefined;
    let ensuredScope: string | undefined;
    let carrier: ReturnType<typeof createEditorTransportCarrier>;
    carrier = createEditorTransportCarrier({
      timeoutMs: 100,
      ensureScope: async (scope) => {
        ensuredScope = scope;
        managed = socket();
        carrier.open(managed as never);
        carrier.message(managed as never, JSON.stringify({
          type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'managed', scope,
        }));
      },
    });

    const pending = carrier.dispatch(request);
    await Bun.sleep(0);
    expect(ensuredScope).toBe('game:spin-cube');
    expect(managed?.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(true);
    carrier.message(managed as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { owner: 'managed' },
    } }));
    await expect(pending).resolves.toMatchObject({ result: { owner: 'managed' } });
  });

  test('retires a redundant managed fallback after its in-flight request settles', async () => {
    const interactiveAuthorities: string[] = [];
    const carrier = createEditorTransportCarrier({
      timeoutMs: 100,
      onInteractiveAuthority: async (scope) => { interactiveAuthorities.push(scope); },
    });
    const managed = socket();
    carrier.open(managed as never);
    carrier.message(managed as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'managed', scope: 'game:spin-cube',
    }));
    const pending = carrier.dispatch(request);
    await Bun.sleep(0);

    const interactive = socket();
    carrier.open(interactive as never);
    carrier.message(interactive as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true, capabilities: { gameplay: true },
    }));
    await Bun.sleep(0);
    expect(interactiveAuthorities).toEqual([]);
    expect(managed.readyState).toBe(1);
    expect(managed.sent.filter((message) => JSON.parse(message).type === 'editor-transport/request')).toHaveLength(1);

    carrier.message(managed as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { owner: 'managed' },
    } }));
    await expect(pending).resolves.toMatchObject({ result: { owner: 'managed' } });
    await Bun.sleep(0);
    expect(interactiveAuthorities).toEqual(['game:spin-cube']);
  });

  test('keeps managed authority until an explicitly unready interactive page publishes gameplay readiness', async () => {
    const interactiveAuthorities: string[] = [];
    let ensureCalls = 0;
    const carrier = createEditorTransportCarrier({
      onInteractiveAuthority: (scope) => { interactiveAuthorities.push(scope); },
      ensureScope: async () => { ensureCalls += 1; },
    });
    const interactive = socket();
    carrier.open(interactive as never);
    carrier.message(interactive as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true, capabilities: { gameplay: false },
    }));
    await Bun.sleep(0);
    expect(interactiveAuthorities).toEqual([]);
    await expect(carrier.dispatch({ ...request, method: 'gameplay' })).resolves.toMatchObject({
      error: { code: 'editor-carrier-unavailable' },
    });
    expect(ensureCalls).toBe(0);

    carrier.message(interactive as never, JSON.stringify({
      type: 'editor-transport/presence', visibility: 'visible', focused: true, capabilities: { gameplay: true },
    }));
    await Bun.sleep(0);
    expect(interactiveAuthorities).toEqual(['game:spin-cube']);
  });

  test('does not ensure a managed page for a connected-only HTTP request', async () => {
    let ensureCalls = 0;
    const carrier = createEditorTransportCarrier({
      timeoutMs: 10,
      ensureScope: async () => { ensureCalls++; },
    });

    const response = await carrier.app.request('/api/editor/transport', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forgeax-editor-carrier-provisioning': '0',
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(503);
    expect(ensureCalls).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'editor-carrier-unavailable' },
    });
  });

  test('forwards a typed request to the connected page and preserves its correlation', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const page = socket();
    carrier.open(page as never);
    carrier.message(page as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube' }));

    const pending = carrier.app.request('/api/editor/transport', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forgeax-editor-carrier-provisioning': '0',
      },
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

  test('routes concurrent game pages by explicit scope and ignores cross-scope responses', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const spin = socket();
    const puzzle = socket();
    carrier.open(spin as never);
    carrier.open(puzzle as never);
    carrier.message(spin as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube' }));
    carrier.message(puzzle as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:2048' }));

    const pending = carrier.dispatch(request);
    await Bun.sleep(0);
    expect(spin.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(true);
    expect(puzzle.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(false);

    const response = {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { scope: 'game:spin-cube' },
    };
    carrier.message(puzzle as never, JSON.stringify({ type: 'editor-transport/response', response }));
    await Bun.sleep(0);
    carrier.message(spin as never, JSON.stringify({ type: 'editor-transport/response', response }));
    await expect(pending).resolves.toMatchObject({ result: { scope: 'game:spin-cube' } });
  });

  test('keeps same-game pages connected and selects the focused healthy carrier', async () => {
    const carrier = createEditorTransportCarrier();
    const first = socket();
    const other = socket();
    const replacement = socket();
    carrier.open(first as never);
    carrier.open(other as never);
    carrier.open(replacement as never);
    carrier.message(first as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:a' }));
    carrier.message(other as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:b' }));
    carrier.message(replacement as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:a',
      visibility: 'visible', focused: true,
    }));

    expect(first.readyState).toBe(1);
    expect(other.readyState).toBe(1);
    expect(replacement.readyState).toBe(1);

    const scoped = { ...request, scope: 'game:a', params: { ...request.params, scope: 'game:a' } };
    const pending = carrier.dispatch(scoped);
    await Bun.sleep(0);
    expect(first.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(false);
    expect(replacement.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(true);
    carrier.close(replacement as never);
    const fallback = carrier.dispatch({ ...scoped, id: 'request-fallback', correlationId: 'correlation-fallback' });
    await Bun.sleep(0);
    expect(first.sent.some((message) => JSON.parse(message).request?.id === 'request-fallback')).toBe(true);

    carrier.message(replacement as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: scoped.id, correlationId: scoped.correlationId, result: {},
    } }));
    await expect(pending).resolves.toMatchObject({ error: { code: 'editor-carrier-unavailable' } });
    carrier.message(first as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: 'request-fallback', correlationId: 'correlation-fallback', result: { fallback: true },
    } }));
    await expect(fallback).resolves.toMatchObject({ result: { fallback: true } });
  });

  test('rejects transport requests without an explicit game scope', async () => {
    const carrier = createEditorTransportCarrier();
    const page = socket();
    carrier.open(page as never);
    carrier.message(page as never, JSON.stringify({ type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube' }));
    const { scope: _scope, ...withoutScope } = request;
    await expect(carrier.dispatch(withoutScope)).resolves.toMatchObject({
      error: { code: 'protocol-invalid-message', retryable: false },
    });
  });

  test('keeps the visible Studio page authoritative when a managed renderer registers later', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const visible = socket();
    const managed = socket();
    carrier.open(visible as never);
    carrier.open(managed as never);
    carrier.message(visible as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
    }));
    carrier.message(managed as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'managed', scope: 'game:spin-cube',
    }));

    const pending = carrier.dispatch(request);
    await Bun.sleep(0);
    expect(visible.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(true);
    expect(managed.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(false);
    carrier.message(visible as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { owner: 'visible' },
    } }));
    await expect(pending).resolves.toMatchObject({ result: { owner: 'visible' } });
    const health = await carrier.app.request('/api/editor/transport/health');
    await expect(health.json()).resolves.toMatchObject({
      carriers: [{ authority: 'interactive', selected: { role: 'interactive' } }],
    });
  });

  test('moves authority when interactive page focus changes without reconnecting', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const first = socket();
    const second = socket();
    carrier.open(first as never);
    carrier.open(second as never);
    for (const page of [first, second]) carrier.message(page as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: false,
    }));
    carrier.message(first as never, JSON.stringify({ type: 'editor-transport/presence', visibility: 'visible', focused: true }));

    const firstRequest = carrier.dispatch(request);
    await Bun.sleep(0);
    expect(first.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(true);
    carrier.message(first as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { owner: 'first' },
    } }));
    await firstRequest;

    carrier.message(first as never, JSON.stringify({ type: 'editor-transport/presence', visibility: 'visible', focused: false }));
    carrier.message(second as never, JSON.stringify({ type: 'editor-transport/presence', visibility: 'visible', focused: true }));
    const switched = { ...request, id: 'request-switched', correlationId: 'correlation-switched' };
    const secondRequest = carrier.dispatch(switched);
    await Bun.sleep(0);
    expect(second.sent.some((message) => JSON.parse(message).request?.id === switched.id)).toBe(true);
    carrier.message(second as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: switched.id,
      correlationId: switched.correlationId, result: { owner: 'second' },
    } }));
    await expect(secondRequest).resolves.toMatchObject({ result: { owner: 'second' } });
  });

  test('fails closed when separate browser processes both report focus', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const passive = socket();
    const userPage = socket();
    carrier.open(passive as never);
    carrier.open(userPage as never);
    carrier.message(userPage as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true,
    }));
    carrier.message(passive as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true,
    }));

    await expect(carrier.dispatch(request)).resolves.toMatchObject({
      error: { code: 'editor-carrier-ambiguous', recoveryActions: ['editor.focus', 'request.retry'] },
    });
    expect(userPage.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(false);
    expect(passive.sent.some((message) => JSON.parse(message).type === 'editor-transport/request')).toBe(false);
  });

  test('routes gameplay only to a carrier that explicitly declares the gameplay capability', async () => {
    const carrier = createEditorTransportCarrier({ timeoutMs: 100 });
    const focusedWithoutViewport = socket();
    const gameplayReady = socket();
    carrier.open(focusedWithoutViewport as never);
    carrier.open(gameplayReady as never);
    carrier.message(focusedWithoutViewport as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true, capabilities: { gameplay: false },
    }));
    carrier.message(gameplayReady as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: false, capabilities: { gameplay: true },
    }));

    const gameplayRequest = { ...request, method: 'gameplay', params: { version: 1, operation: 'capture' } };
    const pending = carrier.dispatch(gameplayRequest);
    await Bun.sleep(0);
    expect(focusedWithoutViewport.sent.some((message) => JSON.parse(message).request?.id === request.id)).toBe(false);
    expect(gameplayReady.sent.some((message) => JSON.parse(message).request?.id === request.id)).toBe(true);
    carrier.message(gameplayReady as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { owner: 'gameplay-ready' },
    } }));
    await expect(pending).resolves.toMatchObject({ result: { owner: 'gameplay-ready' } });
  });

  test('shares one timeout budget across carrier provisioning and response wait', async () => {
    const managed = socket();
    let carrier: ReturnType<typeof createEditorTransportCarrier>;
    carrier = createEditorTransportCarrier({
      timeoutMs: 100,
      ensureScope: async (scope) => {
        await Bun.sleep(70);
        carrier.open(managed as never);
        carrier.message(managed as never, JSON.stringify({
          type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'managed', scope,
        }));
      },
    });
    const startedAt = Date.now();
    await expect(carrier.dispatch(request)).resolves.toMatchObject({ error: { code: 'editor-carrier-timeout' } });
    expect(Date.now() - startedAt).toBeLessThan(140);

    const hung = createEditorTransportCarrier({
      maxTimeoutMs: 15,
      ensureScope: () => new Promise<void>(() => undefined),
    });
    await expect(hung.dispatch({ ...request, timeoutMs: 1_000 })).resolves.toMatchObject({
      error: { code: 'editor-carrier-unavailable' },
    });
  });

  test('bounds request timeouts, reports unknown outcome, and isolates late responses', async () => {
    expect(DEFAULT_EDITOR_TRANSPORT_TIMEOUT_MS).toBe(60_000);
    expect(MAX_EDITOR_TRANSPORT_TIMEOUT_MS).toBe(300_000);
    let ensureCalls = 0;
    const carrier = createEditorTransportCarrier({ timeoutMs: 40, maxTimeoutMs: 15, ensureScope: async () => { ensureCalls += 1; } });
    const page = socket();
    carrier.open(page as never);
    carrier.message(page as never, JSON.stringify({
      type: 'editor-transport/ready', version: 'editor-transport/v1', role: 'interactive', scope: 'game:spin-cube',
      visibility: 'visible', focused: true, capabilities: { gameplay: true },
    }));
    const gameplayRequest = { ...request, timeoutMs: 5, method: 'gameplay', params: { version: 1, operation: 'capture' } };
    await expect(carrier.dispatch(gameplayRequest))
      .resolves.toMatchObject({ error: {
        code: 'editor-carrier-timeout', retryable: false, outcome: 'unknown', operationMayStillBeRunning: true,
      } });
    const capped = { ...gameplayRequest, timeoutMs: 1_000, id: 'request-capped', correlationId: 'correlation-capped' };
    const startedAt = Date.now();
    await expect(carrier.dispatch(capped)).resolves.toMatchObject({
      error: { code: 'editor-carrier-timeout', hint: expect.stringContaining('15ms') },
    });
    expect(Date.now() - startedAt).toBeLessThan(40);

    const recoveredRequest = { ...gameplayRequest, id: 'request-recovered', correlationId: 'correlation-recovered' };
    let recoveredSettled = false;
    const recovered = carrier.dispatch(recoveredRequest).finally(() => { recoveredSettled = true; });
    await Bun.sleep(0);
    carrier.message(page as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: request.id,
      correlationId: request.correlationId, result: { late: true },
    } }));
    await Bun.sleep(0);
    expect(recoveredSettled).toBe(false);
    expect(page.sent.filter((message) => JSON.parse(message).type === 'editor-transport/request')).toHaveLength(3);
    expect(ensureCalls).toBe(0);
    carrier.message(page as never, JSON.stringify({ type: 'editor-transport/response', response: {
      jsonrpc: '2.0', version: 'editor-transport/v1', id: recoveredRequest.id,
      correlationId: recoveredRequest.correlationId, result: { recovered: true },
    } }));
    await expect(recovered).resolves.toMatchObject({ result: { recovered: true } });
  });
});
