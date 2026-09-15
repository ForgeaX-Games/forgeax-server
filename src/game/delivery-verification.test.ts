import { expect, test } from 'bun:test';
import { DeliverSummaryClaimSchema } from '@forgeax/types/deliver-summary';
import { StudioDeliveryClaimSchema, projectGameVerification } from './delivery-verification';
const check = (kind: string) => ({ kind, observation: 'Observed on candidate A in current Play', evidence: 'current-call-42' });

test('a smoke check cannot silently become playable acceptance', () => {
  const claim = StudioDeliveryClaimSchema.parse({ outcome: 'implemented', tests: [{ name: '15 seconds Play, zero console errors', pass: true }] });
  expect(projectGameVerification(claim, 'game').tests).toEqual([
    expect.objectContaining({ name: 'Gameplay acceptance (agent-reported): UNVERIFIED', pass: false }),
    { name: '15 seconds Play, zero console errors', pass: true },
  ]);
});
test('a passed gameplay claim requires interaction and visual evidence without imposing game rules', () => {
  for (const checks of [[], [check('input')], [check('input'), check('state-change')], [check('visual')]]) {
    expect(StudioDeliveryClaimSchema.safeParse({ outcome: 'playable', verification: { scope: 'gameplay', status: 'passed', detail: 'checked', checks } }).success).toBe(false);
  }
  const claim = StudioDeliveryClaimSchema.parse({ outcome: 'playable', verification: { scope: 'gameplay', status: 'passed', detail: 'Collected the item by moving to it', checks: ['input', 'state-change', 'visual'].map(check) } });
  const projected = projectGameVerification(claim, 'game');
  expect(projected.tests?.[0]).toMatchObject({ name: 'Gameplay acceptance (agent-reported): PASSED', pass: true });
  expect(DeliverSummaryClaimSchema.safeParse(projected).success).toBe(true);
  expect(projected).not.toHaveProperty('verification');
});
test('narrow changes and blocked checks do not require a mechanical full-game checklist', () => {
  for (const status of ['failed', 'unverified']) {
    const claim = StudioDeliveryClaimSchema.parse({ outcome: 'implemented', verification: { scope: 'gameplay', status, detail: 'capture unavailable' } });
    expect(projectGameVerification(claim, 'game').tests?.[0]).toMatchObject({ pass: false, detail: 'capture unavailable' });
  }
  const claim = StudioDeliveryClaimSchema.parse({ outcome: 'color updated', verification: { scope: 'changed-behavior', status: 'passed', detail: 'saw requested color', checks: [check('changed-behavior')] } });
  expect(projectGameVerification(claim, 'game').tests).toHaveLength(2);
});
test('non-game summaries remain generic and overflowing projections fail shared validation', () => {
  const claim = StudioDeliveryClaimSchema.parse({ outcome: 'done' });
  expect(projectGameVerification(claim)).toEqual({ outcome: 'done' });
  expect(projectGameVerification(claim, 'default')).toEqual({ outcome: 'done' });
  const crowded = StudioDeliveryClaimSchema.parse({ outcome: 'done', tests: Array.from({ length: 20 }, () => ({ name: 'test', pass: true })) });
  expect(DeliverSummaryClaimSchema.safeParse(projectGameVerification(crowded, 'game')).success).toBe(false);
});
