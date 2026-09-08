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
