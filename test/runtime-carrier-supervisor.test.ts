import { expect, test } from 'bun:test';
import {
  createRuntimeCarrierSupervisor,
  type CarrierHost,
  type CarrierHostHandle,
  type RuntimeScope,
} from '../src/runtime-carrier/supervisor';

const scopeA: RuntimeScope = { projectId: 'project-a', gameId: 'game-a' };
const scopeB: RuntimeScope = { projectId: 'project-b', gameId: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class FakeCarrierHost implements CarrierHost {
  readonly supportsReveal = true;
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly revealed: string[] = [];
  onStart?: (runtimeId: string) => void;
  startGate?: Promise<void>;
  confirmScope = true;

  async start(input: { runtimeId: string; scope: RuntimeScope; ownerToken: string; signal: AbortSignal }): Promise<CarrierHostHandle> {
    this.started.push(input.runtimeId);
    this.onStart?.(input.runtimeId);
    if (this.startGate) await this.startGate;
    return {
      confirmedScope: this.confirmScope ? input.scope : null,
      reveal: async () => { this.revealed.push(input.runtimeId); },
      stop: async () => { this.stopped.push(input.runtimeId); },
    };
  }
}

test('same scope converges concurrent ensure calls onto one runtime', async () => {
  const host = new FakeCarrierHost();
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const results = await Promise.all(Array.from({ length: 11 }, () => supervisor.ensure(scopeA)));

  expect(results.every((result) => result.ok)).toBe(true);
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
  expect(ensureResult).toMatchObject({ ok: false, error: { code: 'STOPPED_DURING_START' } });
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
  const result = await createRuntimeCarrierSupervisor({ host }).ensure(scopeA);
  expect(result).toMatchObject({ ok: false, error: { code: 'SCOPE_UNCONFIRMED' } });
});
