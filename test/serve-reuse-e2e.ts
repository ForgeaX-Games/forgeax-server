/**
 * forgeax-core serve **per-session 复用** E2E(冷启动优化,2026-06-20)—— 真栈 + 真 Anthropic。
 *
 * 跑:`bun packages/server/test/serve-reuse-e2e.ts`(需 ANTHROPIC_API_KEY,经 .env;可选 ANTHROPIC_BASE_URL)。
 *
 * 同时验证「包解析」耦合:adapter 经 `@forgeax/forgeax-core/cli`、sidecar 经 `@forgeax/agent-host/serve`
 * resolved 后再 spawn——若解析/导出/依赖任一处断,下面的真实 spawn 会连不上而失败。
 *
 * 验证 adapter 的 per-session 复用语义(forgeax-core-adapter.ts):
 *  R1 复用:两轮同 session → 复用**同一 serve 进程**(turn1 后进程仍在 + pid 跨轮不变,无 re-spawn)。
 *  R2 idle 回收:静默超过 FORGEAX_CORE_SERVE_IDLE_MS → serve 进程被 reap(getProcess→null)。
 *  R3 崩溃自愈:SIGKILL serve → 驱逐死 session → 下一轮自动重 spawn 并成功(pid 变化)。
 *  R4 软取消不杀进程:turn 中途 abort → 轮收口,但 serve 进程**存活**(pid 不变),后续轮仍可用。
 */
import { ensureSidecar, resetSidecarSingleton } from 'forgeax-cli/kernel/sidecar-singleton';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime';

const MODEL = process.env.FORGEAX_E2E_MODEL || 'claude-opus-4-8';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const serveSessionId = (hostSessionId: string): string => `fxcore:${hostSessionId}`;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

function turnReq(hostSessionId: string, prompt: string): TurnRequest {
  return {
    session: { threadId: hostSessionId, agentId: 'forge' },
    callId: `c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent.', persona: '' },
    tools: [],
    budget: { maxTurns: 4 },
    model: MODEL,
    hostSessionId,
    trustTier: 'own',
  } as TurnRequest;
}

interface KernelLike { runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> }

async function runFull(kernel: KernelLike, hostSessionId: string, prompt: string): Promise<KernelEvent[]> {
  const ac = new AbortController();
  const events: KernelEvent[] = [];
  for await (const e of kernel.runTurn(turnReq(hostSessionId, prompt), ac.signal)) events.push(e);
  return events;
}

function ok(events: KernelEvent[]): boolean {
  return events.some((e) => e.kind === 'message.delta' && !!(e as { text?: string }).text)
    && events.some((e) => e.kind === 'turn.done' && (e as { reason: string }).reason === 'stop')
    && !events.some((e) => e.kind === 'error');
}

async function pidOf(sessionId: string): Promise<number | null> {
  const sc = await ensureSidecar();
  const p = (await sc.getProcess(sessionId)) as { pid: number } | null;
  return p ? p.pid : null;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('需要 ANTHROPIC_API_KEY(经 .env)'); process.exit(2); }
  console.log(`[serve-reuse-e2e] model=${MODEL}\n`);
  const created: string[] = [];

  // ── R1 · 复用同一 serve 进程(无 re-spawn) ──
  console.log('R1 · per-session 复用:两轮同 session 复用同一进程');
  process.env.FORGEAX_CORE_SERVE_IDLE_MS = '60000';
  try {
    const hs = `reuse-${Date.now()}`;
    created.push(serveSessionId(hs));
    const kernel = createForgeaxCoreKernel() as unknown as KernelLike;

    const ev1 = await runFull(kernel, hs, 'Reply with exactly: ONE');
    check('turn1 成功(message.delta + done=stop + 无 error)', ok(ev1), ev1.map((e) => e.kind));
    const pid1 = await pidOf(serveSessionId(hs));
    check('turn1 后 serve 进程仍存活(非 per-turn reap)', pid1 !== null, pid1);

    const ev2 = await runFull(kernel, hs, 'Reply with exactly: TWO');
    check('turn2 成功', ok(ev2), ev2.map((e) => e.kind));
    const pid2 = await pidOf(serveSessionId(hs));
    check('turn2 复用同一进程(pid 跨轮不变,无 re-spawn)', pid1 !== null && pid2 === pid1, { pid1, pid2 });
  } catch (e) { check('R1 未抛异常', false, (e as Error).message); }

  // ── R2 · idle 回收 ──
  console.log('\nR2 · idle 回收:静默超阈值 → serve 进程被 reap');
  process.env.FORGEAX_CORE_SERVE_IDLE_MS = '700';
  try {
    const hs = `idle-${Date.now()}`;
    const sid = serveSessionId(hs);
    const kernel = createForgeaxCoreKernel() as unknown as KernelLike;
    const ev = await runFull(kernel, hs, 'Reply with exactly: IDLE');
    check('turn 成功', ok(ev), ev.map((e) => e.kind));
    const pidAfter = await pidOf(sid);
    check('turn 后进程暂存活(等待 idle)', pidAfter !== null, pidAfter);
    await sleep(1600);
    const pidReaped = await pidOf(sid);
    check('idle 超阈值后进程被 reap(getProcess→null)', pidReaped === null, pidReaped);
  } catch (e) { check('R2 未抛异常', false, (e as Error).message); }

  // ── R3 · 崩溃自愈 ──
  console.log('\nR3 · 崩溃自愈:SIGKILL serve → 下一轮自动重 spawn');
  process.env.FORGEAX_CORE_SERVE_IDLE_MS = '60000';
  try {
    const hs = `crash-${Date.now()}`;
    const sid = serveSessionId(hs);
    created.push(sid);
    const kernel = createForgeaxCoreKernel() as unknown as KernelLike;
    const ev1 = await runFull(kernel, hs, 'Reply with exactly: ALIVE');
    check('turn1 成功', ok(ev1), ev1.map((e) => e.kind));
    const pid1 = await pidOf(sid);
    check('turn1 拿到 serve pid', pid1 !== null, pid1);
    if (pid1) process.kill(pid1, 'SIGKILL');
    for (let i = 0; i < 50 && (await pidOf(sid)) !== null; i++) await sleep(100);
    check('崩溃后 session 被驱逐', (await pidOf(sid)) === null);
    const ev2 = await runFull(kernel, hs, 'Reply with exactly: REBORN');
    check('崩溃后下一轮自动重 spawn 并成功', ok(ev2), ev2.map((e) => e.kind));
    const pid2 = await pidOf(sid);
    check('重 spawn 是新进程(pid 变化)', pid2 !== null && pid2 !== pid1, { pid1, pid2 });
  } catch (e) { check('R3 未抛异常', false, (e as Error).message); }

  // ── R4 · 软取消不杀进程 ──
  console.log('\nR4 · 软取消(RPC)不杀进程:中途 abort → 进程存活、后续轮可用');
  process.env.FORGEAX_CORE_SERVE_IDLE_MS = '60000';
  try {
    const hs = `cancel-${Date.now()}`;
    const sid = serveSessionId(hs);
    created.push(sid);
    const kernel = createForgeaxCoreKernel() as unknown as KernelLike;
    const ev1 = await runFull(kernel, hs, 'Reply with exactly: WARM');
    check('预热 turn 成功', ok(ev1), ev1.map((e) => e.kind));
    const pid1 = await pidOf(sid);
    check('预热后拿到 pid', pid1 !== null, pid1);

    const ac = new AbortController();
    const evC: KernelEvent[] = [];
    let aborted = false;
    for await (const e of kernel.runTurn(turnReq(hs, 'Write a long 200-word essay about the ocean, slowly.'), ac.signal)) {
      evC.push(e);
      if (!aborted) { aborted = true; ac.abort(); }
    }
    check('被取消的轮已收口(出现 turn.done 或 error)', evC.some((e) => e.kind === 'turn.done' || e.kind === 'error'), evC.map((e) => e.kind));
    await sleep(300);
    const pid2 = await pidOf(sid);
    check('软取消后进程存活(pid 不变,未被杀)', pid2 !== null && pid2 === pid1, { pid1, pid2 });

    const ev3 = await runFull(kernel, hs, 'Reply with exactly: STILLHERE');
    check('取消后同 session 仍可继续跑', ok(ev3), ev3.map((e) => e.kind));
  } catch (e) { check('R4 未抛异常', false, (e as Error).message); }

  try {
    const sc = await ensureSidecar();
    for (const sid of created) await sc.shutdownSession(sid).catch(() => {});
  } catch { /* ignore */ }
  try { resetSidecarSingleton(); } catch { /* ignore */ }
  try { const { closeCredVault } = await import('@forgeax/agent-host'); await closeCredVault(); } catch { /* ignore */ }

  console.log(`\n[serve-reuse-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[serve-reuse-e2e] fatal:', e); process.exit(1); });
