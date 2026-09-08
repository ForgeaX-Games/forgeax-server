import { expect, test } from 'bun:test';
import {
  CARRIER_STOP_OPERATION,
  carrierStopIsNotGameplay,
  parseGameplayOperationRequest,
} from '../src/game/gameplay-operation-contract';

test('parses typed gameplay operations and keeps gameplay Stop distinct from carrier Stop', () => {
  const parsed = parseGameplayOperationRequest({
    version: 1,
    requestId: 'play-1',
    operation: 'gameplayStop',
    scope: { projectId: 'project-a', gameId: 'gta-route-dev' },
  });

  expect(parsed).toMatchObject({ ok: true, value: { operation: 'gameplayStop' } });
  expect(CARRIER_STOP_OPERATION).toBe('carrier.stop');
  expect(carrierStopIsNotGameplay('carrier.stop')).toBe(true);
  expect(carrierStopIsNotGameplay('gameplayStop')).toBe(false);
});

test('rejects malformed input and query envelopes at the public boundary', () => {
  expect(parseGameplayOperationRequest({ version: 1, operation: 'input', scope: { projectId: 'p', gameId: 'g' }, requestId: 'r' })).toMatchObject({ ok: false, error: { code: 'malformed-input', category: 'contract' } });
  expect(parseGameplayOperationRequest({ version: 1, operation: 'query', query: '', scope: { projectId: 'p', gameId: 'g' }, requestId: 'r' })).toMatchObject({ ok: false, error: { code: 'malformed-query' } });
  expect(parseGameplayOperationRequest({ version: 1, operation: 'carrier.stop', scope: { projectId: 'p', gameId: 'g' }, requestId: 'r' })).toMatchObject({ ok: false, error: { code: 'malformed-envelope' } });
});
