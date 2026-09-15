import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostToolRunCtx, HostToolSpec } from '@forgeax/orchestrator/seams';
import type { z } from 'zod';
import type { GameVerificationSchema } from './delivery-verification';

type Report = z.infer<typeof GameVerificationSchema>;
type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

/** Fingerprint authored inputs, never sessions, DDC, or generated acceptance data.
 * Unknown/oversized inputs fail verification closed without blocking editing. */
export function gameCandidate(ctx: HostToolRunCtx): string | undefined {
  if (!ctx.game || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ctx.game)) return;
  const root = join(ctx.projectRoot, '.forgeax', 'games', ctx.game);
  const hash = createHash('sha256');
  let bytes = 0, files = 0;
  const walk = (path: string, required = false): void => {
    let stat;
    try { stat = lstatSync(join(root, path)); } catch (error: any) {
      if (!required && error.code === 'ENOENT') { hash.update(`missing:${path}\0`); return; }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Unverifiable linked game input');
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) walk(`${path}/${name}`, true);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (++files > 10_000 || bytes > 64 * 1024 * 1024) throw new Error('Game input exceeds verification budget');
      hash.update(`${path}\0`).update(readFileSync(join(root, path))).update('\0');
    } else throw new Error('Unsupported game input');
  };
  try {
    for (const path of ['forge.json', 'package.json', 'src', 'assets', 'public', 'bun.lock', 'pnpm-lock.yaml']) walk(path, path === 'forge.json' || path === 'src');
    return hash.digest('hex');
  } catch { return; }
}

type Receipt = { id: string; owner: string; candidate: string; runtime: string; operation: string; sequence: number; epoch: number; data?: string };

/** Host-owned observations, scoped to this running server. Restart loses evidence
 * deliberately: a new process cannot certify the old browser's live state.
 * Receipts prove the tool result and candidate, not the agent's interpretation. */
export class GameVerificationEvidence {
  private readonly receipts = new Map<string, Receipt>();
  private readonly runs = new Map<string, { candidate: string; runtime?: string }>();
  private readonly epochs = new Map<string, number>();
  private sequence = 0;
  constructor(private readonly fingerprint = gameCandidate) {}
  private owner(ctx: HostToolRunCtx): string | undefined {
    return ctx.sid && ctx.game ? JSON.stringify([ctx.projectRoot, ctx.sid, ctx.game]) : undefined;
  }
  private invalidate(owner: string): void {
    this.runs.delete(owner);
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [id, receipt] of this.receipts) if (receipt.owner === owner) this.receipts.delete(id);
  }
  /** Called only after the carrier authenticates an asynchronous current-run failure. */
  invalidateContext(ctx: HostToolRunCtx): void {
    const owner = this.owner(ctx);
    if (owner) this.invalidate(owner);
  }
  wrap(tool: HostToolSpec): HostToolSpec {
    const run = tool.run;
    if (!run) return tool;
    return { ...tool, description: `${tool.description} Successful live gameplay input/query/capture results include verificationEvidence.id. Use those exact host-issued IDs in deliver_summary verification checks; edits invalidate old evidence.`, run: async (args, ctx) => {
      const owner = this.owner(ctx);
      const params = object(args.params);
      const gameplay = args.method === 'gameplay';
      const operation = params?.operation;
      // A new Play attempt cannot reuse evidence from the previous run, even
      // when the new attempt fails before obtaining a runtime identity.
      const starting = args.method === 'run.dispatch' && params?.operationId === 'editor.play';
      if (owner && starting) this.invalidate(owner);
      const epoch = owner ? this.epochs.get(owner) ?? 0 : 0;
      const before = owner && (gameplay || starting) ? this.fingerprint(ctx) : undefined;
      let raw: unknown;
      try { raw = await run(args, ctx); } catch (error) { if (owner && gameplay) this.invalidate(owner); throw error; }
      const envelope = object(raw);
      const result = object(envelope?.result);
      if (owner && starting && result?.status === 'succeeded' && before && before === this.fingerprint(ctx) && epoch === (this.epochs.get(owner) ?? 0)) {
        this.runs.set(owner, { candidate: before });
      }
      if (!owner || !gameplay) return raw;
      if (!result || result.ok !== true) {
        this.invalidate(owner);
        // Preserve the producer failure in the payload and expose it to the
        // orchestration tool-result boundary instead of logging transport OK.
        return { ...envelope, ok: false, error: result?.error ?? envelope?.error ?? envelope ?? 'Missing gameplay result' };
      }
      const unavailable = () => ({ ...envelope, verificationEvidence: { status: 'unverified', hint: 'Start a fresh normal editor.play run on the current game before gathering input/query/capture evidence. Inputs must be readable, stable and bounded; runtime/session identity must match.' } });
      const identity = object(result.identity);
      const scope = object(identity?.scope);
      if (!['input', 'query', 'capture'].includes(operation) || !before || before !== this.fingerprint(ctx)
        || epoch !== (this.epochs.get(owner) ?? 0) || scope?.gameId !== ctx.game || scope?.projectId !== ctx.projectRoot || typeof identity?.runtimeId !== 'string') return ['input', 'query', 'capture'].includes(operation) ? unavailable() : raw;
      const runtime = JSON.stringify([identity.runtimeId, identity.rendererGeneration, identity.canvasIdentity]);
      const runState = this.runs.get(owner);
      if (!runState || runState.candidate !== before || (runState.runtime && runState.runtime !== runtime)) return unavailable();
      runState.runtime = runtime;
      const receipt: Receipt = {
        id: `play-evidence-${randomUUID()}`, owner, candidate: before,
        runtime,
        operation, sequence: ++this.sequence, epoch: this.epochs.get(owner) ?? 0,
        ...(operation === 'query' ? { data: JSON.stringify(result.data) } : {}),
      };
      this.receipts.set(receipt.id, receipt);
      while (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value!);
      return { ...envelope, verificationEvidence: { id: receipt.id, candidate: before, operation, runtimeId: identity.runtimeId } };
    } };
  }
  validate(report: Report | undefined, ctx: HostToolRunCtx): string | undefined {
    if (!report || report.status !== 'passed') return;
    const owner = this.owner(ctx), candidate = this.fingerprint(ctx);
    if (!owner || !candidate) return 'Current game inputs or session identity cannot be verified; report unverified.';
    const checks: Array<{ kind: string; receipt: Receipt }> = [];
    for (const check of report.checks) {
      const receipt = this.receipts.get(check.evidence);
      if (!receipt || receipt.owner !== owner || receipt.candidate !== candidate || receipt.epoch !== (this.epochs.get(owner) ?? 0)) {
        return `Missing, stale, or failed-run evidence for ${check.kind}. Run normal Play checks on the current game and use verificationEvidence.id, or report unverified.`;
      }
      const expected = check.kind === 'input' ? ['input'] : check.kind === 'visual' ? ['capture'] : ['query', 'capture'];
      if (!expected.includes(receipt.operation)) return `${check.kind} requires a matching live observation, not a successful unrelated operation.`;
      checks.push({ kind: check.kind, receipt });
    }
    if (new Set(checks.map(({ receipt }) => receipt.runtime)).size !== 1) return 'Verification mixes different Play runtimes; repeat the checks in one current run.';
    if (report.scope === 'gameplay') {
      const first = (kind: string) => checks.find(c => c.kind === kind)?.receipt;
      const input = first('input'), state = first('state-change');
      if (!input || !state || input.sequence >= state.sequence) {
        return 'Interaction evidence requires normal input followed by a live observation in the current run.';
      }
      // Outcomes and restart are request-specific claims. Their receipts remain
      // authenticated above, but the host cannot infer game semantics or impose
      // a terminal-state/restart sequence on open-ended games.
    }
  }
}
