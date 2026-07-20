/**
 * forgeax-core sidecar-serve E2E(R3 内核归一)—— 真栈 + 真 Anthropic。
 *
 * 跑:`bun packages/server/test/serve-e2e.ts`(需 ANTHROPIC_API_KEY,可选 ANTHROPIC_BASE_URL)。
 *
 * 覆盖:
 *  1) serve-direct + 真模型 + 反向 host-tool happy:spawn `forgeax-core --serve` → 连 → runTurn,
 *     模型调工具 → hostTool 反向 RPC 触发 → tool.result + message.delta + usage-before-done + done.
 *  2) serve-direct + 反向 host-tool DENY 传播:hostTool handler 抛(模拟 checkKernelTool deny)→
 *     tool.result ok=false 折回模型 → 轮仍正常收口(信任边界 deny 经 serve 端到端传播)。
 *  3) 全链路(真 adapter → ensureSidecar → cred-vault scoped → serve → 真模型,无工具):
 *     验真 key 经 stripModelKeys 剔除后,serve 靠 sidecar 注入的 scoped token + 环回 proxy 仍能跑通。
 *  4) 崩溃隔离:sidecar 托管的 serve 子进程被 SIGKILL → onExit{crash} 上报、sidecar 存活、父存活。
 */
import { resolve } from 'node:path';
import { connect, type RpcConnection } from '@forgeax/agent-host';
import { ensureSidecar, resetSidecarSingleton } from '@forgeax/orchestrator/kernel/sidecar-singleton';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime';

const CORE_SERVE = resolve(import.meta.dir, '../../cli/src/cli/main.ts');
// 默认用 forgeax llm-proxy 已支持的模型;FORGEAX_E2E_MODEL 可覆盖(proxy 须支持该 id)。
const MODEL = process.env.FORGEAX_E2E_MODEL || 'claude-opus-4-8';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

async function connectRetry(sock: string, deadlineMs = 8000): Promise<RpcConnection> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    try { return await connect(sock, 1000); } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`serve endpoint not reachable: ${sock}`);
    await sleep(150);
  }
}

const TOOL = { name: 'get_time', description: 'Returns the current time. Always succeeds.', inputSchema: { type: 'object', properties: {} } };
function turnReq(prompt: string, withTool: boolean): TurnRequest {
  return {
    session: { threadId: `t-${Date.now()}`, agentId: 'forge' },
    callId: `c-${Date.now()}`,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent.', persona: '' },
    tools: withTool ? [TOOL] : [],
    budget: { maxTurns: 4 },
    model: MODEL,
    hostSessionId: 'sid-e2e',
    trustTier: 'own',
  } as TurnRequest;
}

/** 直连一个 serve-direct 子进程跑一轮,返回事件 + host-tool 调用记录。 */
async function serveDirectTurn(opts: {
  prompt: string;
  hostTool: (p: { name: string; args: unknown; sid?: string }) => Promise<unknown>;
}): Promise<{ events: KernelEvent[]; calls: Array<{ name: string }> }> {
  const sock = `/tmp/fxe2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`;
  const proc = Bun.spawn({ cmd: ['bun', CORE_SERVE, '--serve', '--sock', sock], env: process.env as Record<string, string>, stdout: 'ignore', stderr: 'inherit' });
  try {
    const conn = await connectRetry(sock);
    const calls: Array<{ name: string }> = [];
    conn.setRequestHandler(async (method, params) => {
      if (method === 'hostTool') { const p = params as { name: string; args: unknown; sid?: string }; calls.push({ name: p.name }); return opts.hostTool(p); }
      throw Object.assign(new Error(`unknown ${method}`), { code: -32601 });
    });
    const events: KernelEvent[] = [];
    conn.onNotify((method, params) => { if (method === 'event') events.push((params as { event: KernelEvent }).event); });
    await conn.request('runTurn', turnReq(opts.prompt, true));
    conn.close();
    return { events, calls };
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

function kinds(evs: KernelEvent[]): string[] { return evs.map((e) => e.kind); }
function usageBeforeDone(evs: KernelEvent[]): boolean {
  const k = kinds(evs); const u = k.indexOf('turn.usage'); const d = k.indexOf('turn.done');
  return u >= 0 && d > u;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('需要 ANTHROPIC_API_KEY'); process.exit(2); }
  console.log(`[serve-e2e] model=${MODEL}\n`);

  // ── E2E-1: serve-direct + 真模型 + 反向 host-tool happy ──
  console.log('E2E-1 · serve-direct + 真模型 + 反向 host-tool(happy)');
  try {
    const { events, calls } = await serveDirectTurn({
      prompt: 'Call the get_time tool exactly once, then reply with the single word DONE.',
      hostTool: async () => ({ time: '2026-06-20T12:00:00Z' }),
    });
    check('hostTool 反向回调触发(get_time)', calls.some((c) => c.name === 'get_time'), calls);
    check('收到 tool.call', kinds(events).includes('tool.call'));
    check('收到 tool.result', kinds(events).includes('tool.result'));
    check('收到 message.delta(文本流)', events.some((e) => e.kind === 'message.delta' && !!e.text));
    check('usage 在 done 之前(B5 不变量)', usageBeforeDone(events));
    check('turn.done reason=stop', events.some((e) => e.kind === 'turn.done' && (e as { reason: string }).reason === 'stop'));
  } catch (e) { check('E2E-1 未抛异常', false, (e as Error).message); }

  // ── E2E-2: 反向 host-tool DENY 传播 ──
  console.log('\nE2E-2 · 反向 host-tool DENY 经 serve 端到端传播');
  try {
    const { events, calls } = await serveDirectTurn({
      prompt: 'Call the get_time tool exactly once, then reply DONE.',
      hostTool: async () => { throw new Error('tool "get_time" denied for imported pack (test)'); },
    });
    check('hostTool 被调用(deny 路径)', calls.some((c) => c.name === 'get_time'), calls);
    const tr = events.find((e) => e.kind === 'tool.result') as { ok?: boolean; error?: string } | undefined;
    check('tool.result 折回 ok=false(deny 传播)', !!tr && tr.ok === false, tr);
    check('轮仍正常收口(turn.done)', events.some((e) => e.kind === 'turn.done'));
  } catch (e) { check('E2E-2 未抛异常', false, (e as Error).message); }

  // ── E2E-3: 全链路 adapter → sidecar → cred-vault scoped → serve → 真模型 ──
  console.log('\nE2E-3 · 全链路(真 adapter + sidecar + cred-vault scoped + 真模型,无工具)');
  try {
    const kernel = createForgeaxCoreKernel();
    const events: KernelEvent[] = [];
    const ac = new AbortController();
    for await (const e of kernel.runTurn(turnReq('Reply with exactly: PONG', false), ac.signal)) events.push(e);
    check('全链路收到 message.delta', events.some((e) => e.kind === 'message.delta' && !!e.text));
    check('全链路 turn.done reason=stop', events.some((e) => e.kind === 'turn.done' && (e as { reason: string }).reason === 'stop'));
    check('无 error 事件(scoped token 经 cred-vault proxy 跑通)', !events.some((e) => e.kind === 'error'), events.filter((e) => e.kind === 'error'));
  } catch (e) { check('E2E-3 未抛异常', false, (e as Error).message); }

  // ── E2E-4: 崩溃隔离(SIGKILL serve 子进程 → sidecar/父 存活) ──
  console.log('\nE2E-4 · 崩溃隔离(SIGKILL serve → onExit{crash} + sidecar 存活)');
  try {
    const client = await ensureSidecar();
    const sock = `/tmp/fxe2e-crash-${Date.now()}.sock`;
    let exited: { reason: string } | null = null;
    client.onExit((info) => { if (info.sessionId === 'crash-sess') exited = info as { reason: string }; });
    const grant = await client.startSession({
      sessionId: 'crash-sess', agentId: 'forge', trustTier: 'own', callId: 'crash-sess', endpoint: sock,
      kernel: { kind: 'forgeax-core', credential: 'user-managed', serveMode: true, cmd: 'bun', args: [CORE_SERVE, '--serve', '--sock', sock], cwd: process.cwd(), env: process.env as Record<string, string> },
    });
    check('sidecar spawn serve 成功(pid>0)', grant.pid > 0, grant.pid);
    check('grant.endpoint 回显', grant.endpoint === sock, grant.endpoint);
    await connectRetry(sock).then((c) => c.close()); // 等 serve listen
    process.kill(grant.pid, 'SIGKILL'); // 硬杀 serve leader
    for (let i = 0; i < 60 && !exited; i++) await sleep(100);
    check('serve 崩 → onExit 触发', !!exited, exited);
    check('onExit reason=crash', (exited as { reason: string } | null)?.reason === 'crash', exited);
    const png = await client.ping();
    check('sidecar 存活(ping ok)', !!png && typeof png.pid === 'number');
    check('父进程存活(执行到此即证明)', true);
  } catch (e) { check('E2E-4 未抛异常', false, (e as Error).message); }

  // 清理。
  try { resetSidecarSingleton(); } catch { /* ignore */ }
  try { const { closeCredVault } = await import('@forgeax/agent-host'); await closeCredVault(); } catch { /* ignore */ }

  console.log(`\n[serve-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[serve-e2e] fatal:', e); process.exit(1); });
