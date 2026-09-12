import { z } from 'zod';
import { DeliverSummaryClaimSchema } from '@forgeax/types/deliver-summary';

/** Studio owns gameplay policy. Generic delivery contracts continue to carry
 * ordinary tests; the product projects this report into their existing UI. */
export const GameVerificationSchema = z.object({
  scope: z.enum(['gameplay', 'changed-behavior']),
  status: z.enum(['passed', 'failed', 'unverified']),
  detail: z.string().trim().min(1).max(200),
  checks: z.array(z.object({
    kind: z.enum(['input', 'state-change', 'core-result', 'changed-behavior', 'visual', 'audio']),
    observation: z.string().trim().min(1).max(100),
    evidence: z.string().trim().min(1).max(100),
  }).strict()).max(8).default([]),
}).strict().superRefine((report, ctx) => {
  if (report.status !== 'passed') return;
  const required = report.scope === 'gameplay' ? ['input', 'state-change', 'core-result'] : ['changed-behavior'];
  for (const kind of required) {
    if (!report.checks.some((check) => check.kind === kind && check.evidence.trim() && check.observation.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checks'], message: `passed ${report.scope} requires an observed ${kind} check with an evidence reference` });
    }
  }
});

export const StudioDeliveryClaimSchema = DeliverSummaryClaimSchema.extend({ verification: GameVerificationSchema.optional() });

export const GAME_VERIFICATION_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scope', 'status', 'detail'],
  properties: {
    scope: { enum: ['gameplay', 'changed-behavior'], description: 'Use gameplay for new games or gameplay changes; changed-behavior for a narrowly scoped presentation/content change.' },
    status: { enum: ['passed', 'failed', 'unverified'] },
    detail: { type: 'string', minLength: 1, maxLength: 200 },
    checks: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['kind', 'observation', 'evidence'],
      properties: {
        kind: { enum: ['input', 'state-change', 'core-result', 'changed-behavior', 'visual', 'audio'] },
        observation: { type: 'string', minLength: 1, maxLength: 100 },
        evidence: { type: 'string', minLength: 1, maxLength: 100, description: 'Reference a current normal-path tool call or artifact. A Play start, console silence, timeout, or unavailable result cannot prove gameplay.' },
      },
    } },
  },
} as const;

/** Reports are explicitly attributed to the agent; schema validation cannot
 * authenticate an observation. Missing reports remain unverified, even when
 * unrelated build or smoke tests passed. Do not promote this to host proof. */
export function projectGameVerification(claim: z.infer<typeof StudioDeliveryClaimSchema>, game?: string) {
  const { verification, ...generic } = claim;
  if (!game || game === 'default') return generic;
  const report = verification ?? { scope: 'gameplay' as const, status: 'unverified' as const, detail: 'No scoped gameplay evidence was reported. Build success, Play startup and console silence do not establish playability.', checks: [] };
  const tests = [
    { name: `${report.scope === 'gameplay' ? 'Gameplay' : 'Changed behavior'} acceptance (agent-reported): ${report.status.toUpperCase()}`, pass: report.status === 'passed', detail: report.detail },
    ...report.checks.map((check) => ({ name: `Observed ${check.kind}`, pass: report.status === 'passed', detail: `${check.observation} [${check.evidence}]`.slice(0, 200) })),
    ...(generic.tests ?? []),
  ];
  // Preserve the shared max-20 contract without silently dropping evidence or
  // user tests. The caller validates this projection before enrichment.
  return { ...generic, tests };
}
