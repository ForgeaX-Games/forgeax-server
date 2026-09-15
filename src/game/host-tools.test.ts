import { describe, expect, it } from 'bun:test';
import { gameHostTools, studioHostTools } from './host-tools';

const deliverSummary = gameHostTools().find((tool) => tool.name === 'deliver_summary');
const deliverSummaryRun = deliverSummary?.run;

if (!deliverSummaryRun) {
  throw new Error('deliver_summary host tool is not registered');
}

describe('deliver_summary host tool', () => {
  it('loads the product module with the typed transport and a fail-closed relay default', () => {
    const names = studioHostTools().map((tool) => tool.name);
    expect(names).toContain('deliver_summary');
    expect(names).toContain('editor_transport');
    expect(names).not.toContain('editor_ui_browse');
    expect(names).not.toContain('editor_gateway_eval');
    expect(names).not.toContain('gameplay');
  });

  it('includes DEV relay tools only for the resolved healthy capability', () => {
    const names = studioHostTools(undefined, {
      editorRelay: {
        available: true,
        baseUrl: 'http://127.0.0.1:25295',
        reason: 'available',
      },
    }).map((tool) => tool.name);
    expect(names).toContain('editor_transport');
    expect(names).toContain('editor_ui_browse');
    expect(names).toContain('editor_gateway_eval');
  });

  it('rejects malformed or host-derived args before enrichment', async () => {
    const result = await deliverSummaryRun(
      { outcome: 'done', files: [] },
      { agentId: 'forge', projectRoot: '/tmp/project' },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('arguments invalid');
  });

  it('reports the missing orchestrator enrichment seam explicitly', async () => {
    const result = await deliverSummaryRun(
      { outcome: 'done' },
      { agentId: 'forge', projectRoot: '/tmp/project' },
    );
    expect(result).toEqual({
      ok: false,
      error: 'deliver_summary enrichment unavailable: orchestrator delivery seam is not configured',
    });
  });

  it('passes only the validated claim to the enrichment seam', async () => {
    let received: unknown;
    const result = await deliverSummaryRun(
      { outcome: 'done', next: ['continue'], roundLabel: 'Round 1' },
      {
        agentId: 'forge',
        projectRoot: '/tmp/project',
        delivery: {
          enrich: async (claim) => {
            received = claim;
            return {
              ...claim,
              files: [],
              meta: { durationMs: 0, agents: ['forge'] },
            };
          },
        },
      },
    );
    expect(received).toEqual({ outcome: 'done', next: ['continue'], roundLabel: 'Round 1' });
    expect(result).toEqual({
      ok: true,
      summary: {
        outcome: 'done',
        next: ['continue'],
        roundLabel: 'Round 1',
        files: [],
        meta: { durationMs: 0, agents: ['forge'] },
      },
    });
  });
});

it('normal Studio composition shares live evidence with delivery and rejects edits before enrichment', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const projectRoot = mkdtempSync(join(tmpdir(), 'studio-delivery-'));
  const root = join(projectRoot, '.forgeax/games/kart');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'forge.json'), '{}'); writeFileSync(join(root, 'src/main.ts'), 'candidate A');
  let enrichments = 0;
  const ctx = { agentId: 'forge', sid: 'session', game: 'kart', projectRoot, delivery: { enrich: async (claim: any) => {
    enrichments++; return { ...claim, files: [], meta: { durationMs: 0, agents: ['forge'] } };
  } } };
  const tools = studioHostTools({ dispatch: async req => ({ jsonrpc: '2.0', result: req.method === 'run.dispatch' ? { status: 'succeeded' } : {
    ok: true, operation: (req.params as any).operation, data: req.params,
    identity: { runtimeId: 'runtime', scope: { gameId: 'kart', projectId: projectRoot }, rendererGeneration: 1, canvasIdentity: 'canvas' },
  } }) });
  const run = (name: string, args: any) => tools.find(t => t.name === name)!.run!(args, ctx) as Promise<any>;
  try {
    await run('editor_transport', { method: 'run.dispatch', params: { operationId: 'editor.play' } });
    const checks = [];
    for (const [kind, operation] of [['input', 'input'], ['state-change', 'query'], ['core-result', 'query'], ['input', 'input'], ['restart', 'query'], ['visual', 'capture']]) {
      const result = await run('editor_transport', { method: 'gameplay', params: { operation, observation: kind } });
      checks.push({ kind, observation: kind, evidence: result.verificationEvidence.id });
    }
    const args = { outcome: 'Race completed and restarted', verification: { scope: 'gameplay', status: 'passed', detail: 'Normal controls', checks } };
    expect(await run('deliver_summary', args)).toMatchObject({ ok: true });
    expect(enrichments).toBe(1);
    writeFileSync(join(root, 'src/main.ts'), 'candidate B');
    expect(await run('deliver_summary', args)).toMatchObject({ ok: false, error: expect.stringContaining('stale') });
    expect(enrichments).toBe(1);
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
