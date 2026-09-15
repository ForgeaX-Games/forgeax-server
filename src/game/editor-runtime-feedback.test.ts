import { expect, test } from 'bun:test';
import { EditorRuntimeFeedback, runtimeFailureEvent } from './editor-runtime-feedback';
const context = { sid: 'session', game: 'kart', projectRoot: '/project', agentId: 'forge' };
const request = (correlationId = 'play1') => ({ scope: 'game:kart', correlationId, method: 'run.dispatch', params: { operationId: 'editor.play' } });
const message = (type = 'VAG_CARRIER_FAILURE', correlationId = 'play1', pageNonce = 'page1') => ({
  type: 'editor-transport/runtime-event', version: 'editor-transport/v1', correlationId,
  event: { type, payload: { version: 1, scope: { projectId: '/project', gameId: 'kart' }, runtimeId: 'runtime', runtimeGeneration: 1, pageNonce,
    failure: { code: 'app-system-update-failed', hint: 'Missing component', at: new Date().toISOString() } } },
});
test('current failure retains producer time and original caller; repeated messages are deduplicated', () => {
  const received: any[] = [], socket = {};
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  const error = message();
  expect(feedback.message(socket, 'game:kart', error)).toBe(true);
  expect(received[0].context).toEqual(context);
  expect(received[0].payload.failure.at).toBe(error.event.payload.failure.at);
  expect(feedback.message(socket, 'game:kart', error)).toBe(false);
  expect(received).toHaveLength(1);
});
test('foreign socket, game, project, correlation and old page document cannot route feedback', () => {
  const received: unknown[] = [], socket = {};
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_HANDSHAKE'))).toBe(true);
  expect(feedback.message({}, 'game:kart', message())).toBe(false);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'old'))).toBe(false);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'play1', 'old-page'))).toBe(false);
  for (const scope of [{ projectId: '/other', gameId: 'kart' }, { projectId: '/project', gameId: 'other' }]) {
    const event = message(); event.event.payload.scope = scope;
    expect(feedback.message(socket, 'game:kart', event)).toBe(false);
  }
  expect(received).toHaveLength(0);
});
test('new Play supersedes prior run even if runtimeGeneration is unchanged; stop and disconnect clear owners', () => {
  const received: unknown[] = [], socket = {};
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  feedback.message(socket, 'game:kart', message('VAG_CARRIER_HANDSHAKE'));
  feedback.dispatch(socket, request('play2'), context);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_HANDSHAKE', 'play2', 'page2'))).toBe(true);
  expect(feedback.message(socket, 'game:kart', message())).toBe(false);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'play2', 'page2'))).toBe(true);
  feedback.dispatch(socket, request('play3'), context);
  feedback.dispatch(socket, { ...request(), params: { operationId: 'editor.stop' } });
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'play3'))).toBe(false);
  feedback.dispatch(socket, request(), context); feedback.close(socket);
  expect(feedback.message(socket, 'game:kart', message())).toBe(false);
});
test('UI requests cannot select a kernel recipient or retain prior host ownership', () => {
  const received: unknown[] = [], socket = {};
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  feedback.dispatch(socket, { ...request(), params: { operationId: 'editor.play', sessionId: 'forged' } });
  expect(feedback.message(socket, 'game:kart', message())).toBe(false);
  expect(received).toHaveLength(0);
});

test('original heartbeat can bind a ready run; unknown payload versions cannot', () => {
  const socket = {}, received: unknown[] = [];
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  const invalid = message('VAG_CARRIER_HEARTBEAT'); invalid.event.payload.version = 2;
  expect(feedback.message(socket, 'game:kart', invalid)).toBe(false);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_HEARTBEAT'))).toBe(true);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'play1', 'old-page'))).toBe(false);
  expect(feedback.message(socket, 'game:kart', message())).toBe(true);
  expect(received).toHaveLength(1);
});

test('active feedback preserves actual kernel/model and original timing; idle does not start a turn', () => {
  const feedback = { context, correlationId: 'play1', receivedAt: Date.now(), payload: message().event.payload };
  const active = runtimeFailureEvent(feedback, { kernelId: 'codex', model: 'gpt-5.6-luna' });
  expect(active.handoff).toBe('steer');
  expect(active.to).toBe('forge');
  expect(active.payload).toMatchObject({ kernelId: 'codex', model: 'gpt-5.6-luna' });
  expect(JSON.parse(active.payload.content)).toMatchObject({ occurredAt: feedback.payload.failure.at, receivedAt: feedback.receivedAt, observationsInvalidated: true });
  const idle = runtimeFailureEvent(feedback);
  expect(idle.handoff).toBe('silent');
  expect(idle.payload.kernelId).toBeUndefined();
  expect(idle.payload.model).toBeUndefined();
});

test('idempotent Play preserves the running page original failure correlation', () => {
  const socket = {}, received: unknown[] = [];
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  feedback.message(socket, 'game:kart', message('VAG_CARRIER_HANDSHAKE'));
  feedback.dispatch(socket, request('repeat'), context);
  expect(feedback.message(socket, 'game:kart', message())).toBe(true);
  expect(received).toHaveLength(1);
  feedback.dispatch(socket, { ...request(), params: { operationId: 'editor.stop' } });
  feedback.dispatch(socket, request('after-stop'), context);
  expect(feedback.message(socket, 'game:kart', message())).toBe(false);
});

test.each(['VAG_CARRIER_HANDSHAKE', 'VAG_CARRIER_FAILURE'])('entering-play repeat retains original first %s', type => {
  const socket = {}, received: unknown[] = [];
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  feedback.dispatch(socket, request('repeat-before-ready'), context);
  expect(feedback.message(socket, 'game:kart', message(type))).toBe(true);
  if (type === 'VAG_CARRIER_HANDSHAKE') {
    expect(feedback.message(socket, 'game:kart', message())).toBe(true);
  }
  expect(received).toHaveLength(1);
  expect(feedback.message(socket, 'game:kart', message('VAG_CARRIER_FAILURE', 'repeat-before-ready'))).toBe(false);
});

test('early startup failure delivers bounded producer diagnostics without enabling an idle turn', () => {
  const socket = {}, received: any[] = [];
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  const event = message();
  Object.assign(event.event.payload.failure, { diagnostics: [{ code: 'pack-source-external-closure-mismatch', sourcePath: './assets/scene.pack.ts', undeclaredReferencedGuids: ['guid'], undeclaredReadGuids: ['read-guid'], expected: 'declare referenced assets', missingGuids: ['missing'], sourceKey: 'scene/main', stack: 'private' }] });
  expect(feedback.message(socket, 'game:kart', event)).toBe(true);
  const projected = runtimeFailureEvent(received[0]);
  expect(projected.handoff).toBe('silent');
  expect(JSON.parse(projected.payload.content).diagnostics).toEqual([{ code: 'pack-source-external-closure-mismatch', sourcePath: './assets/scene.pack.ts', undeclaredReferencedGuids: ['guid'], undeclaredReadGuids: ['read-guid'], expected: 'declare referenced assets', missingGuids: ['missing'], sourceKey: 'scene/main' }]);
  feedback.dispatch(socket, { ...request(), params: { operationId: 'editor.stop' } });
  expect(feedback.message(socket, 'game:kart', event)).toBe(false);
});

test('a different generation cannot replace the established page failure identity', () => {
  const socket = {}, received: unknown[] = [];
  const feedback = new EditorRuntimeFeedback(value => received.push(value));
  feedback.dispatch(socket, request(), context);
  feedback.message(socket, 'game:kart', message('VAG_CARRIER_HANDSHAKE'));
  const late = message(); late.event.payload.runtimeGeneration = 2;
  expect(feedback.message(socket, 'game:kart', late)).toBe(false);
  expect(received).toEqual([]);
});
