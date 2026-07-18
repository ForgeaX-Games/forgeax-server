/**
 * 内环切换 e2e —— 验证「chat 真正经 forgeax-core 内核驱动」(非 claude-code)。
 * 走真实编排层链路:createForgeaxApp boot → runKernelTurn → composeTurnRequest →
 * resolveKernel(=forgeax-core) → ForgeaxCoreKernel.runTurn → 真 Anthropic + in-process
 * host-tool 桥。非 .test.ts(真 API);手动跑:
 *   set -a; source <repo>/.env; set +a
 *   FORGEAX_KERNEL_IMPL=forgeax-core bun test/inner-ring-e2e.ts
 * 退出码 = 失败数。
 */
import { createForgeaxApp } from 'forgeax-cli';
import { runKernelTurn } from 'forgeax-cli/core/kernel-turn';
import { resolveKernel } from 'forgeax-cli/kernel/resolve-kernel';
import { getSessionManager } from 'forgeax-cli/core/session-manager';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { Hook } from 'forgeax-cli/hooks/types';
import { registerForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('需要 ANTHROPIC_API_KEY(先 source .env)。');
  process.exit(2);
}
// 切内环 → forgeax-core(产品壳行为)。
process.env.FORGEAX_KERNEL_IMPL = 'forgeax-core';
registerForgeaxCoreKernel();

/** 捕获 eventBus.hook(StreamLLM) 的文本/工具流。 */
function capturingBus() {
  const text: string[] = [];
  const toolCalls: string[] = [];
  const bus = {
    hook(event: string, payload: unknown) {
      if (event === Hook.StreamLLM) {
        const chunk = (payload as { chunk?: { type?: string; text?: string; name?: string } }).chunk;
        if (chunk?.type === 'text' && chunk.text) text.push(chunk.text);
        if (chunk?.type === 'tool_call' && chunk.name) toolCalls.push(chunk.name);
      }
    },
  };
  return { bus: bus as never, text: () => text.join(''), toolCalls: () => toolCalls };
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: ok ? 'PASS' : detail });

async function safe(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<void> {
  try {
    const { ok, detail } = await fn();
    check(name, ok, detail ?? '');
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  await createForgeaxApp({ projectRoot: defaultProjectRoot(), version: 'e2e', broadcast: () => {} });

  // 1) 内环 = forgeax-core
  await safe('switch · resolveKernel("forge").id === forgeax-core', async () => {
    const id = resolveKernel('forge').id;
    return { ok: id === 'forgeax-core', detail: `got ${id}` };
  });

  // 2) 文本 turn:真模型经 forgeax-core 驱动
  await safe('text turn · forgeax-core → real model → INNER_RING_OK', async () => {
    const cap = capturingBus();
    const r = await runKernelTurn({
      agentId: 'forge',
      userText: 'Reply with exactly this token and nothing else: INNER_RING_OK',
      eventBus: cap.bus,
      signal: new AbortController().signal,
      turn: 0,
    });
    const out = cap.text();
    return { ok: !r.error && out.includes('INNER_RING_OK'), detail: `err=${r.error} out=${out.slice(0, 80)}` };
  });

  // 3) 工具 turn:真模型调 host-tool list_games,经 in-process 桥执行(真 session+root agent)
  await safe('tool turn · model invokes list_games via in-process bridge', async () => {
    const session = await getSessionManager().create({ autoStart: true });
    session.scheduler.start();
    const cap = capturingBus();
    const r = await runKernelTurn({
      agentId: 'forge',
      sessionId: session.sid,
      userText: 'Use the list_games tool to list the game projects, then tell me how many there are.',
      eventBus: cap.bus,
      signal: new AbortController().signal,
      turn: 0,
      tools: [{ name: 'list_games', description: 'List game projects. Returns { count, games }.', inputSchema: { type: 'object', properties: {} } }],
    });
    return { ok: !r.error && cap.toolCalls().includes('list_games'), detail: `err=${r.error} tools=[${cap.toolCalls().join(',')}]` };
  });

  // 4) subagent turn:facade 注入的原生 Task 在内环路径可用 —— 真模型派子 agent
  await safe('subagent · facade 注入 Task,内环可派 subagent', async () => {
    const session = await getSessionManager().create({ autoStart: true });
    session.scheduler.start();
    const cap = capturingBus();
    const r = await runKernelTurn({
      agentId: 'forge',
      sessionId: session.sid,
      userText: 'Use the Task tool to delegate to a subagent: ask it to reply with the word SUBPONG. Then tell me what the subagent said.',
      eventBus: cap.bus,
      signal: new AbortController().signal,
      turn: 0,
    });
    return { ok: !r.error && cap.toolCalls().includes('Task'), detail: `err=${r.error} tools=[${cap.toolCalls().join(',')}]` };
  });
}

main()
  .then(() => {
    console.log('\n========== 内环切换 e2e ==========');
    let fails = 0;
    for (const r of results) {
      if (!r.ok) fails++;
      console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.ok ? '' : '  —— ' + r.detail}`);
    }
    console.log('==================================');
    console.log(`${results.length - fails}/${results.length} 通过`);
    process.exit(fails);
  })
  .catch((e) => {
    console.error('e2e crashed:', e);
    process.exit(1);
  });
