/**
 * 全流程 e2e —— 走**真实产品 HTTP 入口**驱动一轮聊天,验证整条链路:
 *   POST /api/sessions(建会话+scaffold forge)→ POST /:sid/messages(真 chat 入口)
 *   → scheduler → conscious-agent loop → runKernelTurn → resolveKernel(=forgeax-core)
 *   → ForgeaxCoreKernel → 真 Anthropic → host-tool 桥 / subagent → 流式回 bus(=前端 WS 源)。
 * 断言落在 agent bus 事件(WS 桥接的就是它)。非 .test.ts(真 API + 全栈 boot);手动跑:
 *   set -a; source <repo>/.env; set +a && bun run e2e:full
 */
import { createForgeaxApp } from '@forgeax/orchestrator';
import { getSessionManager } from '@forgeax/orchestrator/core/session-manager';
import { resolveKernel } from '@forgeax/orchestrator/kernel/resolve-kernel';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { registerForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('需要 ANTHROPIC_API_KEY(先 source .env)。');
  process.exit(2);
}
process.env.FORGEAX_KERNEL_IMPL = 'forgeax-core';
registerForgeaxCoreKernel();

let app!: Awaited<ReturnType<typeof createForgeaxApp>>['app'];

function extractAssistantText(payload: unknown): string {
  const content = (payload as { llmMessage?: { content?: unknown } } | undefined)?.llmMessage?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

interface ChatResult {
  httpStatus: number;
  streamText: string;
  assistantText: string;
  tools: string[];
  done: boolean;
  error?: string;
}

async function runChat(content: string, timeoutMs = 75_000): Promise<ChatResult> {
  // 1) 真 HTTP 建会话(scaffold forge root agent)
  const createRes = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultDir: 'default' }),
  });
  const { sid } = (await createRes.json()) as { sid: string };
  const session = getSessionManager().peek(sid)!;

  // 2) 订阅 agent bus(= 前端 WS 桥接源)
  let streamText = '';
  let assistantText = '';
  const tools: string[] = [];
  let done = false;
  let error: string | undefined;
  const unsub = session.eventBus.observe((ev: { type: string; payload?: unknown }) => {
    if (ev.type === 'stream:llm') {
      const chunk = (ev.payload as { chunk?: { type?: string; text?: string } }).chunk;
      if (chunk?.type === 'text' && chunk.text) streamText += chunk.text;
    } else if (ev.type === 'hook:assistantMessage') {
      assistantText += extractAssistantText(ev.payload);
    } else if (ev.type === 'hook:toolCall') {
      const name = (ev.payload as { name?: string }).name;
      if (name) tools.push(name);
    } else if (ev.type === 'hook:turnEnd') {
      done = true;
      error = (ev.payload as { error?: string }).error;
    }
  });

  // 3) 真 HTTP 发消息(产品 chat 入口)
  const msgRes = await app.request(`/api/sessions/${sid}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, to: 'forge' }),
  });

  // 4) 等本轮结束(turnEnd)或超时
  const start = Date.now();
  while (!done && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400));
  }
  unsub();
  return { httpStatus: msgRes.status, streamText, assistantText, tools, done, error };
}

const has = (s: string, sub: string) => s.toLowerCase().includes(sub.toLowerCase());
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}  (${detail})`); // 即时反馈
}

async function main(): Promise<void> {
  ({ app } = await createForgeaxApp({ projectRoot: defaultProjectRoot(), version: 'e2e', broadcast: () => {} }));

  record('switch · 内环 = forgeax-core', resolveKernel('forge').id === 'forgeax-core', resolveKernel('forge').id,);

  // 全流程 1:文本 turn(HTTP → forgeax-core → 真模型)
  {
    const r = await runChat('Reply with exactly this token and nothing else: FULL_FLOW_OK');
    const out = r.assistantText || r.streamText;
    record('full-flow text · HTTP→scheduler→conscious-agent→forgeax-core→real model', r.done && !r.error && has(out, 'FULL_FLOW_OK'), `http=${r.httpStatus} done=${r.done} err=${r.error} out=${out.slice(0, 60)}`,);
  }

  // 全流程 2:工具 turn(真模型调 host-tool list_games,经桥执行)
  {
    const r = await runChat('Use the list_games tool to list the game projects in this workspace, then tell me how many there are.');
    record('full-flow tool · model→list_games via in-process bridge', r.done && !r.error && (r.tools.includes('list_games') || has(r.assistantText, 'game')), `http=${r.httpStatus} done=${r.done} err=${r.error} tools=[${r.tools.join(',')}]`,);
  }

  // 全流程 3:subagent turn(facade 注入 Task → 真模型派子 agent)
  {
    const r = await runChat('Use the Task tool to delegate to a subagent: ask it to reply with the word FLOWPONG, then tell me what it said.');
    record('full-flow subagent · model→Task→isolated child agent', r.done && !r.error && (r.tools.includes('Task') || has(r.assistantText, 'flowpong')), `http=${r.httpStatus} done=${r.done} err=${r.error} tools=[${r.tools.join(',')}]`,);
  }
}

main()
  .then(() => {
    console.log('\n============ 全流程 e2e(真实 HTTP 产品入口）============');
    let fails = 0;
    for (const r of results) {
      if (!r.ok) fails++;
      console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.ok ? '' : '  —— ' + r.detail}`);
    }
    console.log('======================================================');
    console.log(`${results.length - fails}/${results.length} 通过`);
    process.exit(fails);
  })
  .catch((e) => {
    console.error('full-flow e2e crashed:', e);
    process.exit(1);
  });
