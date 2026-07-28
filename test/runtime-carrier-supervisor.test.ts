import { expect, test } from 'bun:test';
import {
  createRuntimeCarrierSupervisor,
  type CarrierHost,
  type CarrierHostHandle,
  type CarrierHostObservation,
  type RuntimeScope,
} from '../src/runtime-carrier/supervisor';

const scopeA: RuntimeScope = { projectId: 'project-a', gameId: 'game-a' };
const scopeB: RuntimeScope = { projectId: 'project-b', gameId: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitForRunning(supervisor: ReturnType<typeof createRuntimeCarrierSupervisor>, runtimeId: string) {
  for (let i = 0; i < 20; i++) {
    const result = await supervisor.status(runtimeId);
    if (result.ok && result.lifecycle !== 'starting') return result;
    await Bun.sleep(0);
  }
  return await supervisor.status(runtimeId);
}

class FakeCarrierHost implements CarrierHost {
  readonly supportsReveal = true;
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly revealed: string[] = [];
  onStart?: (runtimeId: string) => void;
  startGate?: Promise<void>;
  confirmScope = true;
  reportedRuntimeId?: string;
  reportedChallenge?: string | null;
  reportedScope?: RuntimeScope | null;
  observeImpl?: () => Promise<CarrierHostObservation>;

  async start(input: { runtimeId: string; scope: RuntimeScope; ownerToken: string; signal: AbortSignal }): Promise<CarrierHostHandle> {
    this.started.push(input.runtimeId);
    this.onStart?.(input.runtimeId);
    if (this.startGate) await this.startGate;
    return {
      runtimeId: this.reportedRuntimeId ?? input.runtimeId,
      challengeResponse: this.reportedChallenge === undefined ? input.ownerToken : this.reportedChallenge,
      confirmedScope: this.reportedScope === undefined ? (this.confirmScope ? input.scope : null) : this.reportedScope,
      pageNonce: `page-${input.runtimeId}`,
      pageIdentity: 'http://localhost:18920/preview/',
      canvasIdentity: `canvas-${input.runtimeId}`,
      rendererIdentity: `renderer-${input.runtimeId}`,
      sentinel: 0,
      reveal: async () => { this.revealed.push(input.runtimeId); },
      stop: async () => { this.stopped.push(input.runtimeId); },
      ...(this.observeImpl ? { observe: this.observeImpl } : {}),
    };
  }
}

test('same scope converges concurrent ensure calls onto one runtime', async () => {
  const host = new FakeCarrierHost();
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const results = await Promise.all(Array.from({ length: 11 }, () => supervisor.ensure(scopeA)));

  expect(results.every((result) => result.ok && (result.lifecycle === 'starting' || result.lifecycle === 'running'))).toBe(true);
  expect(new Set(results.filter((result) => result.ok).map((result) => result.runtimeId)).size).toBe(1);
  expect(host.started).toHaveLength(1);
});

test('different scope is a structured conflict and never starts a second carrier', async () => {
  const host = new FakeCarrierHost();
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const first = await supervisor.ensure(scopeA);
  const second = await supervisor.ensure(scopeB);

  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: false, error: { code: 'SCOPE_CONFLICT', requestedScope: scopeB, occupyingScope: scopeA } });
  expect(host.started).toHaveLength(1);
});

test('stop during start wins, does not publish running, and preserves a stopped terminal snapshot', async () => {
  const gate = deferred<void>();
  const host = new FakeCarrierHost();
  host.startGate = gate.promise;
  const supervisor = createRuntimeCarrierSupervisor({ host });
  let stopPromise: Promise<unknown> | undefined;
  host.onStart = (runtimeId) => { stopPromise = supervisor.stop(runtimeId); };

  const ensurePromise = supervisor.ensure(scopeA);
  while (!stopPromise) await Promise.resolve();
  gate.resolve();

  const ensureResult = await ensurePromise;
  const stopResult = await stopPromise;
  expect(ensureResult).toMatchObject({ ok: true, lifecycle: 'stopping' });
  expect(stopResult).toMatchObject({ ok: true, lifecycle: 'stopped' });
  if (!stopResult || typeof stopResult !== 'object' || !('runtimeId' in stopResult)) throw new Error('missing runtimeId');
  expect(await supervisor.status(stopResult.runtimeId as string)).toMatchObject({ ok: true, lifecycle: 'stopped' });
  expect(supervisor.snapshot()).toBeNull();
});

test('stopping rejects ensure and repeated stop is idempotent', async () => {
  const host = new FakeCarrierHost();
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected ensure to succeed');

  const firstStop = supervisor.stop(ensured.runtimeId);
  const whileStopping = await supervisor.ensure(scopeA);
  const secondStop = await supervisor.stop(ensured.runtimeId);

  expect(whileStopping).toMatchObject({ ok: false, error: { code: 'RUNTIME_STOPPING' } });
  expect(await firstStop).toEqual(secondStop);
  expect(host.stopped).toEqual([ensured.runtimeId]);
});

test('stopped runtime remains queryable but a new ensure gets a new runtimeId', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host: new FakeCarrierHost() });
  const first = await supervisor.ensure(scopeA);
  if (!first.ok) throw new Error('expected ensure to succeed');
  await supervisor.stop(first.runtimeId);

  expect(await supervisor.status(first.runtimeId)).toMatchObject({ ok: true, lifecycle: 'stopped' });
  const second = await supervisor.ensure(scopeA);
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.runtimeId).not.toBe(first.runtimeId);
});

test('unknown runtime ids are rejected without adoption or process discovery', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host: new FakeCarrierHost() });
  expect(await supervisor.status('old-runtime')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RUNTIME' } });
  expect(await supervisor.reveal('old-runtime')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RUNTIME' } });
  expect(await supervisor.stop('old-runtime')).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RUNTIME' } });
});

test('default host keeps reveal explicit and unsupported until M3', async () => {
  const result = await createRuntimeCarrierSupervisor().ensure(scopeA);
  expect(result).toMatchObject({ ok: false, error: { code: 'REVEAL_UNSUPPORTED' } });
});

test('unconfirmed scope cannot be published as running', async () => {
  const host = new FakeCarrierHost();
  host.confirmScope = false;
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const result = await supervisor.ensure(scopeA);
  expect(result).toMatchObject({ ok: true, lifecycle: 'starting' });
  if (result.ok) {
    await Bun.sleep(0);
    expect(await supervisor.status(result.runtimeId)).toMatchObject({ ok: true, lifecycle: 'failed', lastFailure: { code: 'SCOPE_UNCONFIRMED' } });
  }
});

test('handshake rejects a page that reports a different runtime identity and reclaims the host', async () => {
  const host = new FakeCarrierHost();
  host.reportedRuntimeId = 'unmanaged-runtime';
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected starting identity');
  const status = await waitForRunning(supervisor, ensured.runtimeId);

  expect(status).toMatchObject({ ok: true, lifecycle: 'failed', lastFailure: { code: 'HANDSHAKE_RUNTIME_MISMATCH' } });
  expect(host.stopped).toEqual([ensured.runtimeId]);
  expect(supervisor.snapshot()).toBeNull();
});

test('handshake rejects a page that fails the one-time ownership challenge', async () => {
  const host = new FakeCarrierHost();
  host.reportedChallenge = 'wrong-owner';
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected starting identity');
  const status = await waitForRunning(supervisor, ensured.runtimeId);

  expect(status).toMatchObject({ ok: true, lifecycle: 'failed', lastFailure: { code: 'HANDSHAKE_OWNERSHIP_MISMATCH' } });
  expect(host.stopped).toEqual([ensured.runtimeId]);
});

test('duplicate health observations do not refresh freshness and stale health is explicit', async () => {
  const host = new FakeCarrierHost();
  host.observeImpl = async () => ({
    confirmedScope: scopeA,
    sentinel: 0,
    liveness: 'alive',
    renderReadiness: 'ready',
  });
  const supervisor = createRuntimeCarrierSupervisor({ host, healthStaleMs: 10 });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected starting identity');
  await waitForRunning(supervisor, ensured.runtimeId);
  const first = await supervisor.status(ensured.runtimeId);
  await Bun.sleep(2);
  const duplicate = await supervisor.status(ensured.runtimeId);
  expect(first.ok && duplicate.ok && duplicate.heartbeat?.at).toBe(first.ok ? first.heartbeat?.at : undefined);
  await Bun.sleep(15);
  expect(await supervisor.status(ensured.runtimeId)).toMatchObject({
    ok: true,
    lifecycle: 'running',
    liveness: 'unreachable',
    renderReadiness: 'unavailable',
    lastFailure: { code: 'HEALTH_STALE', stage: 'heartbeat' },
  });
});

test('page reload retires the old runtime identity before a new ensure', async () => {
  let reloaded = false;
  const host = new FakeCarrierHost();
  host.observeImpl = async () => ({
    confirmedScope: scopeA,
    pageNonce: reloaded ? 'page-reloaded' : 'page-current',
    pageIdentity: 'http://localhost:18920/preview/',
    canvasIdentity: reloaded ? 'canvas-reloaded' : 'canvas-current',
    rendererIdentity: reloaded ? 'renderer-reloaded' : 'renderer-current',
    sentinel: reloaded ? 2 : 1,
    liveness: 'alive',
    renderReadiness: 'ready',
  });
  // The start handle supplies the baseline page identity; the next observe is
  // intentionally a new page nonce so the supervisor must retire it.
  const originalStart = host.start.bind(host);
  host.start = async (input) => {
    const handle = await originalStart(input);
    return { ...handle, pageNonce: 'page-current', canvasIdentity: 'canvas-current', rendererIdentity: 'renderer-current', observe: async () => {
      reloaded = true;
      return await host.observeImpl!();
    } };
  };
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected starting identity');
  await waitForRunning(supervisor, ensured.runtimeId);
  const reloadedStatus = await supervisor.status(ensured.runtimeId);
  expect(reloadedStatus).toMatchObject({ ok: true, lifecycle: 'failed', lastFailure: { code: 'PAGE_RELOADED' } });
  const next = await supervisor.ensure(scopeA);
  expect(next.ok).toBe(true);
  if (next.ok) expect(next.runtimeId).not.toBe(ensured.runtimeId);
});

test('host stop failure remains structured and keeps ownership available for retry', async () => {
  const host: CarrierHost = {
    supportsReveal: true,
    async start(input) {
      return {
        runtimeId: input.runtimeId,
        challengeResponse: input.ownerToken,
        confirmedScope: input.scope,
        pageNonce: 'page-stop-failure',
        pageIdentity: 'http://localhost:18920/preview/',
        canvasIdentity: 'canvas-stop-failure',
        rendererIdentity: 'renderer-stop-failure',
        sentinel: 1,
        reveal: async () => {},
        stop: async () => { throw new Error('close failed'); },
      };
    },
  };
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected starting identity');
  await waitForRunning(supervisor, ensured.runtimeId);
  expect(await supervisor.stop(ensured.runtimeId)).toMatchObject({ ok: false, action: 'stop', error: { code: 'HOST_STOP_FAILED', stage: 'stop' } });
  expect(await supervisor.status(ensured.runtimeId)).toMatchObject({ ok: true, lifecycle: 'failed', lastFailure: { code: 'HOST_STOP_FAILED' } });
});
