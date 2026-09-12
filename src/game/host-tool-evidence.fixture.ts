import { expect, mock } from 'bun:test';

// These legacy relay adapters are unrelated to game-host evidence. Keep this
// unit boundary independent of a booted Orchestrator/App and relay process.
mock.module('./editor-gateway-host-tools', () => ({ editorGatewayHostTools: () => [] }));
mock.module('./editor-ui-browse-host-tools', () => ({ editorUiBrowseHostTools: () => [] }));
mock.module('./editor-transport-carrier', () => ({ MAX_EDITOR_TRANSPORT_TIMEOUT_MS: 300_000 }));
const { gameHostTools } = await import('./host-tools');
const tools = gameHostTools();
const ctx = { agentId: 'forge', projectRoot: '/tmp/isolated-host-test', game: 'fixture' };
const tool = (name: string) => tools.find((entry) => entry.name === name)!.run!;
const enrich = async (claim: any) => ({ ...claim, files: [], meta: { durationMs: 0, agents: ['forge'] } });

{
  // Neither normal desktop boot nor an unrelated DEV relay restores the
  // retired PlaySurface receiver. Only advertise implemented host operations.
  for (const capabilities of [undefined, { editorRelay: { available: true, baseUrl: 'http://127.0.0.1:1234', reason: 'available' as const } }]) {
    const names = gameHostTools(capabilities).map(entry => entry.name);
    expect(names).not.toContain('capture_frame');
    expect(names).not.toContain('query_world');
    expect(names).toContain('deliver_summary');
  }
}

{
  const result = await tool('deliver_summary')({ outcome: 'implemented', tests: [{ name: 'Play smoke', pass: true }] }, { ...ctx, delivery: { enrich } });
  expect(result).toMatchObject({ ok: true, summary: { tests: [
    { name: 'Gameplay acceptance (agent-reported): UNVERIFIED', pass: false },
    { name: 'Play smoke', pass: true },
  ] } });
}
{
  let calls = 0;
  const result = await tool('deliver_summary')({ outcome: 'playable', verification: { scope: 'gameplay', status: 'passed', detail: '15 seconds Play', checks: [] } }, { ...ctx, delivery: { enrich: async (claim) => { calls++; return enrich(claim); } } });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('requires an observed input') });
  expect(calls).toBe(0);
}
