import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameVerificationEvidence, gameCandidate } from './game-verification-evidence';

const ctx = { projectRoot: '/project', game: 'kart', sid: 'session', agentId: 'forge' };
function fixture() {
  let candidate = 'A', runtimeId = 'runtime1', fail = false;
  const evidence = new GameVerificationEvidence(() => candidate);
  const tool = evidence.wrap({ name: 'editor_transport', description: '', inputSchema: {}, run: async args => ({
    result: args.method === 'run.dispatch' ? { status: 'succeeded' } : fail ? { ok: false, error: { code: 'game-read-failed' } } : {
      ok: true, identity: { scope: { projectId: ctx.projectRoot, gameId: ctx.game }, runtimeId, rendererGeneration: 1, canvasIdentity: 'canvas' }, data: args.params,
    },
  }) });
  let started = false;
  const observe = async (operation: string, value: string) => {
    if (!started) { await tool.run!({ method: 'run.dispatch', params: { operationId: 'editor.play' } }, ctx); started = true; }
    const r = await tool.run!({ method: 'gameplay', params: { operation, value } }, ctx) as any;
    return r.verificationEvidence?.id;
  };
  const report = async () => ({ scope: 'gameplay' as const, status: 'passed' as const, detail: 'Race completed and restarted', checks: [
    { kind: 'input' as const, observation: 'Drive', evidence: await observe('input', 'W') },
    { kind: 'state-change' as const, observation: 'Racing', evidence: await observe('query', 'racing') },
    { kind: 'core-result' as const, observation: 'Finished', evidence: await observe('query', 'finished') },
    ...await (async () => { await observe('input', 'restart'); return [{ kind: 'restart' as const, observation: 'Menu', evidence: await observe('query', 'menu') }]; })(),
    { kind: 'visual' as const, observation: 'Visible', evidence: await observe('capture', 'frame') },
  ] });
  return { evidence, tool, observe, report, change: () => candidate = 'B', runtime: () => runtimeId = 'runtime2', fail: () => fail = true };
}

test('accepts matching current-run observations and rejects invented IDs', async () => {
  const f = fixture(), r = await f.report();
  expect(f.evidence.validate(r, ctx)).toBeUndefined();
  r.checks[0].evidence = 'I tested it';
  expect(f.evidence.validate(r, ctx)).toContain('Missing, stale');
});
test('edits, different sessions, games and process restart cannot reuse evidence', async () => {
  const f = fixture(), r = await f.report();
  expect(f.evidence.validate(r, { ...ctx, sid: 'other' })).toContain('Missing, stale');
  expect(f.evidence.validate(r, { ...ctx, game: 'other' })).toContain('Missing, stale');
  expect(new GameVerificationEvidence(() => 'A').validate(r, ctx)).toContain('Missing, stale');
  f.change();
  expect(f.evidence.validate(r, ctx)).toContain('Missing, stale');
});
test('producer failure reaches tool boundary and invalidates prior pass', async () => {
  const f = fixture(), r = await f.report(); f.fail();
  const result = await f.tool.run!({ method: 'gameplay', params: { operation: 'query' } }, ctx);
  expect(result).toMatchObject({ ok: false, error: { code: 'game-read-failed' } });
  expect(f.evidence.validate(r, ctx)).toContain('Missing, stale');
});
test('new Play and mixed runtime captures cannot reuse old success', async () => {
  const f = fixture(), r = await f.report(); f.runtime();
  r.checks[4].evidence = await f.observe('capture', 'new-frame');
  expect(f.evidence.validate(r, ctx)).toContain('Missing, stale');
  await f.tool.run!({ method: 'run.dispatch', params: { operationId: 'editor.play' } }, ctx);
  expect(f.evidence.validate(r, ctx)).toContain('Missing, stale');
});
test('open-ended gameplay does not require a terminal result or restart', async () => {
  const f = fixture(), r = await f.report();
  r.checks = r.checks.filter(c => c.kind !== 'core-result' && c.kind !== 'restart');
  expect(f.evidence.validate(r, ctx)).toBeUndefined();
  const early = await f.observe('query', 'before-input');
  r.checks[0].evidence = await f.observe('input', 'move');
  r.checks[1].evidence = early;
  expect(f.evidence.validate(r, ctx)).toContain('input followed by');
});
test('failed and unverified reports remain deliverable, narrowed checks still need evidence', async () => {
  const f = fixture();
  for (const status of ['failed', 'unverified'] as const) expect(f.evidence.validate({ scope: 'gameplay', status, detail: 'blocked', checks: [] }, ctx)).toBeUndefined();
  expect(f.evidence.validate({ scope: 'changed-behavior', status: 'passed', detail: 'color fixed', checks: [{ kind: 'changed-behavior', observation: 'color', evidence: await f.observe('capture', 'color') }] }, ctx)).toBeUndefined();
});
test('candidate includes authored sources and resources but excludes session writes; symlinks fail closed', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'game-evidence-'));
  const root = join(projectRoot, '.forgeax/games/kart');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'forge.json'), '{}'); writeFileSync(join(root, 'src/main.ts'), 'a');
  const c = { ...ctx, projectRoot };
  try {
    const first = gameCandidate(c); expect(first).toBeString();
    mkdirSync(join(root, 'sessions')); writeFileSync(join(root, 'sessions/events'), 'event');
    expect(gameCandidate(c)).toBe(first);
    writeFileSync(join(root, 'assets/mesh.bin'), 'mesh'); expect(gameCandidate(c)).not.toBe(first);
    symlinkSync(join(root, 'src/main.ts'), join(root, 'assets/link')); expect(gameCandidate(c)).toBeUndefined();
    expect(gameCandidate({ ...c, game: '../escape' })).toBeUndefined();
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});

test('an in-flight observation cannot acquire evidence after a newer Play attempt', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => release = resolve);
  const evidence = new GameVerificationEvidence(() => 'A');
  const tool = evidence.wrap({ name: 'editor_transport', description: '', inputSchema: {}, run: async args => args.method === 'run.dispatch' ? { result: { status: 'succeeded' } } : pending });
  const start = () => tool.run!({ method: 'run.dispatch', params: { operationId: 'editor.play' } }, ctx);
  await start();
  const observation = tool.run!({ method: 'gameplay', params: { operation: 'query' } }, ctx);
  await start();
  release({ result: { ok: true, data: 'old', identity: { runtimeId: 'old', scope: { gameId: ctx.game, projectId: ctx.projectRoot } } } });
  expect(await observation).not.toHaveProperty('verificationEvidence.id');
});

test('authenticated async failure invalidates only the owning session evidence', async () => {
  const f = fixture(), report = await f.report();
  f.evidence.invalidateContext({ ...ctx, sid: 'other' });
  expect(f.evidence.validate(report, ctx)).toBeUndefined();
  f.evidence.invalidateContext(ctx);
  expect(f.evidence.validate(report, ctx)).toContain('Missing, stale');
});
