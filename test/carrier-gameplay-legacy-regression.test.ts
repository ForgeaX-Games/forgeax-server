import { describe, expect, test } from 'bun:test';
import { GAMEPLAY_OPERATIONS, parseGameplayOperation } from '../src/game/gameplay-operation-contract';

describe('carrier gameplay legacy regression', () => {
  test('keeps typed gameplay separate from legacy eval and carrier stop', () => {
    expect(GAMEPLAY_OPERATIONS).toContain('gameplayStop');
    expect(GAMEPLAY_OPERATIONS).not.toContain('eval');
    expect(parseGameplayOperation({ operation: 'gameplayStop', scope: { projectId: 'p', gameId: 'g' } })).toMatchObject({ operation: 'gameplayStop' });
  });
  test('rejects arbitrary eval before any dispatch', () => {
    expect(() => parseGameplayOperation({ operation: 'eval', scope: { projectId: 'p', gameId: 'g' }, code: 'new World()' })).toThrow(/unknown operation/);
  });
});
