import { expect, test } from 'bun:test';
import {
  createRuntimeCarrierSupervisor,
  type CarrierHost,
  type CarrierHostHandle,
  type RuntimeScope,
} from '../src/runtime-carrier/supervisor';
import type { CarrierHealthObservation } from '../src/runtime-carrier/health';

const scopeA: RuntimeScope = { projectId: 'project-a', gameId: 'game-a' };

const host: CarrierHost = {
  supportsReveal: true,
  async start(input): Promise<CarrierHostHandle> {
    return {
      confirmedScope: input.scope,
      renderReadiness: 'ready',
      reveal: async () => {},
      stop: async () => {},
    };
  },
};

function observation(runtimeId: string, overrides: Partial<CarrierHealthObservation> = {}): CarrierHealthObservation {
  return {
    runtimeId,
    confirmedScope: scopeA,
    pageNonce: 'page-a',
    pageIdentity: 'http://localhost:18920/editor',
    canvasIdentity: 'canvas-a',
    rendererIdentity: 'renderer-a',
    sentinel: 1,
    liveness: 'alive',
    renderReadiness: 'ready',
    failure: null,
    ...overrides,
  };
}

test('scope drift keeps runtime identity while updating confirmed scope', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected ensure to succeed');

  const nextScope = { projectId: 'project-b', gameId: null };
  const updated = await supervisor.ingestCarrierHealth(ensured.runtimeId, observation(ensured.runtimeId, { confirmedScope: nextScope }));

  expect(updated).toMatchObject({
    ok: true,
    runtimeId: ensured.runtimeId,
    confirmedScope: nextScope,
    lastFailure: { code: 'SCOPE_DRIFT' },
  });
});

test('unconfirmed health clears confirmed scope without inventing a replacement', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected ensure to succeed');

  const updated = await supervisor.ingestCarrierHealth(ensured.runtimeId, observation(ensured.runtimeId, { confirmedScope: null }));

  expect(updated).toMatchObject({
    ok: true,
    runtimeId: ensured.runtimeId,
    confirmedScope: null,
    lastFailure: { code: 'SCOPE_UNCONFIRMED', retryable: true },
  });
});

test('device loss makes the current snapshot unavailable without changing runtime id', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected ensure to succeed');

  const updated = await supervisor.ingestCarrierHealth(ensured.runtimeId, observation(ensured.runtimeId, {
    renderReadiness: 'unavailable',
    failure: {
      code: 'device-lost',
      stage: 'device-lost',
      retryable: false,
      hint: 'Stop the runtime and ensure it again.',
      at: '2026-07-27T00:00:00.000Z',
      message: 'The WebGPU device was lost.',
    },
  }));

  expect(updated).toMatchObject({
    ok: true,
    runtimeId: ensured.runtimeId,
    lifecycle: 'running',
    renderReadiness: 'unavailable',
    lastFailure: {
      code: 'device-lost',
      retryable: false,
      hint: 'Stop the runtime and ensure it again.',
    },
  });
  expect((await supervisor.ensure(scopeA)).ok).toBe(true);
});

test('uncaptured renderer errors map to the current failure snapshot as best effort', async () => {
  const supervisor = createRuntimeCarrierSupervisor({ host });
  const ensured = await supervisor.ensure(scopeA);
  if (!ensured.ok) throw new Error('expected ensure to succeed');

  const updated = await supervisor.ingestCarrierHealth(ensured.runtimeId, observation(ensured.runtimeId, {
    renderReadiness: 'unavailable',
    failure: {
      code: 'limit-exceeded',
      stage: 'uncaptured-error',
      retryable: true,
      hint: 'Inspect the renderer error, then stop and ensure if it persists.',
      at: '2026-07-27T00:00:00.000Z',
    },
  }));

  expect(updated).toMatchObject({
    ok: true,
    runtimeId: ensured.runtimeId,
    renderReadiness: 'unavailable',
    lastFailure: { code: 'limit-exceeded', retryable: true, stage: 'uncaptured-error' },
  });
});
