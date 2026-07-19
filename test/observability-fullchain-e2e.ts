/**
 * 全链路 trace 真栈 E2E(非 .test.ts;真 Anthropic + 真 server adapter + 真 serve 子进程)。
 * 跑:  set -a; source <repo>/.env; set +a;  bun packages/server/test/observability-fullchain-e2e.ts
 *
 * 证明:浏览器起的 root(ui.send→ui.request)与后端(kernel.turn→agent.run→tool)经 traceparent
 * 串成**同一棵 trace**,且**全部落项目本地** `<projectRoot>/.forgeax/sessions/<sid>/logs/trace.jsonl`。
 *
 * 模拟浏览器侧:用真 telemetry-file-sink(= /api/telemetry 路由背后的同一 sink、同一项目路径)写
 * ui.send/ui.request 两条 span(就是浏览器 trace.ts 产、经 POST /api/telemetry 落的那两条);
 * 把 ui.request 的 W3C traceparent 注入 TurnRequest → 真 adapter.runTurn → sidecar kernel.turn
 * 挂成它的 child。最后回读 trace.jsonl 断言一棵树。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';
import { createTelemetryFileSink } from '../src/kernel/telemetry-file-sink';
import { initPathManager, getPathManager } from '@forgeax/orchestrator/fs/path-manager';
import { FlatSessionLayout } from '@forgeax/orchestrator/fs/session-layout';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

const MODEL = process.env.FORGEAX_E2E_MODEL || process.env.FORGEAX_MODEL || 'claude-opus-4-8';
const SID = `obs-fullchain-${Date.now()}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hex = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
};

function turnReq(prompt: string, traceparent: string): TurnRequest {
  return {
    session: { threadId: `t-${randomUUID()}`, agentId: 'forge' },
    callId: `c-${randomUUID()}`,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent. Answer in one word.', persona: '' },
    tools: [],
    budget: { maxTurns: 4 },
    model: MODEL,
    hostSessionId: SID,
    trustTier: 'own',
    traceparent, // ← 浏览器 ui.request 的 traceparent(全链路串联)
  } as TurnRequest;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[obs-fullchain-e2e] 跳过:未设 ANTHROPIC_API_KEY(需 `set -a; source .env; set +a`)。');
    process.exit(0);
  }
  // 装一个 SessionLayout(扁平,workDir=projectRoot),logs 路径由 PathManager 决定。
  const projectRoot = process.env.FORGEAX_PROJECT_ROOT ?? process.cwd();
  initPathManager({ projectRoot, layout: new FlatSessionLayout(resolve(projectRoot, '.forgeax', 'sessions'), projectRoot) });
  const logsDir = getPathManager().session(SID).logsDir();
  const traceFile = join(logsDir, 'trace.jsonl');
  console.log(`[obs-fullchain-e2e] model=${MODEL} sid=${SID}`);
  console.log(`[obs-fullchain-e2e] 项目本地落盘: ${logsDir}\n`);

  // ── 1. 模拟浏览器侧:经真 sink(= /api/telemetry 同路径)写 ui.send(root)+ ui.request ──
  //   sink 省略 resolveLogsDir → 默认走 getPathManager().session(sid).logsDir()(同上 layout)。
  const sink = createTelemetryFileSink({});
  const traceId = hex(16);
  const uiSendId = hex(8);
  const uiReqId = hex(8);
  const now = Date.now();
  sink.write(SID, [
    { kind: 'span', traceId, spanId: uiSendId, name: 'ui.send', startTs: now, endTs: now + 1, sid: SID, agentId: 'forge', status: { code: 'ok' } },
    { kind: 'span', traceId, spanId: uiReqId, parentSpanId: uiSendId, name: 'ui.request', startTs: now, sid: SID, agentId: 'forge', provisional: true },
  ]);
  const traceparent = `00-${traceId}-${uiReqId}-01`;

  // ── 2. 后端:真模型经真 adapter.runTurn,kernel.turn 挂 ui.request 下 ──
  const kernel = createForgeaxCoreKernel({});
  const ac = new AbortController();
  const events: KernelEvent[] = [];
  console.log('runTurn(真模型,traceparent ← 浏览器 ui.request)…');
  try {
    for await (const ev of kernel.runTurn(turnReq('Reply with exactly the word DONE.', traceparent), ac.signal)) events.push(ev);
  } catch (e) {
    console.log(`  runTurn error: ${(e as Error).message}`);
  }
  await sleep(600);

  // ── 3. 回读 + 断言一棵树 ──
  console.log(`\n================ 项目 .forgeax 落盘回读 ================`);
  console.log(`trace.jsonl: ${existsSync(traceFile) ? 'OK' : 'MISSING'} → ${traceFile}`);
  const lines = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const spans = lines.map((l) => JSON.parse(l) as { name: string; traceId: string; spanId: string; parentSpanId?: string; endTs?: number });
  const finalOf = (name: string) => spans.find((s) => s.name === name && (name === 'ui.request' ? true : s.endTs != null)) ?? spans.find((s) => s.name === name);

  const uiSend = finalOf('ui.send');
  const uiReq = finalOf('ui.request');
  const kt = finalOf('kernel.turn');
  const ar = finalOf('agent.run');
  for (const s of spans.filter((x) => x.endTs != null).slice(0, 10)) {
    console.log(`  · ${String(s.name).padEnd(12)} trace=${s.traceId.slice(0, 12)} span=${s.spanId.slice(0, 8)} parent=${(s.parentSpanId ?? '-').slice(0, 8)}`);
  }

  const sameTrace = !!uiSend && !!kt && !!ar && uiSend.traceId === traceId && kt.traceId === traceId && ar.traceId === traceId;
  const ktUnderUiReq = !!kt && kt.parentSpanId === uiReqId;
  const arUnderKt = !!kt && !!ar && ar.parentSpanId === kt.spanId;
  const uiReqUnderSend = !!uiReq && uiReq.parentSpanId === uiSendId;

  console.log('\n================ 断言 ================');
  console.log(`  ${sameTrace ? '✅' : '❌'} 浏览器 + 后端 span 同一 traceId(${traceId.slice(0, 12)}…)`);
  console.log(`  ${uiReqUnderSend ? '✅' : '❌'} ui.request 挂 ui.send 下`);
  console.log(`  ${ktUnderUiReq ? '✅' : '❌'} kernel.turn 挂浏览器 ui.request 下(跨进程串联)`);
  console.log(`  ${arUnderKt ? '✅' : '❌'} agent.run 挂 kernel.turn 下`);
  const ok = sameTrace && ktUnderUiReq && arUnderKt && uiReqUnderSend;
  console.log(`\n${ok ? '✅ 全链路 E2E 通过' : '❌ 失败'} · 一棵树落:${logsDir}`);
  process.exit(ok ? 0 : 1);
}

void main();
