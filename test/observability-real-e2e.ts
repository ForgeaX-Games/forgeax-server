/**
 * 可观测性「真生产路径」E2E(非 .test.ts;真 Anthropic + 真 server adapter + 真 .forgeax 落盘)。
 * 跑:  set -a; source <repo>/.env; set +a;  bun packages/server/test/observability-real-e2e.ts
 *
 * 与 core 那个 e2e 的区别:这里**直接调真 server 的 `createForgeaxCoreKernel().runTurn()`**
 *  —— 与 HTTP 路由(/api/cli/...)调内核同一入口。它内部:
 *    spawn 真 `forgeax-core --serve` 子进程 → serve.ts 的 makeNodeObservability 产 telemetry →
 *    RPC `telemetry` 回流 → 真 adapter.handleTelemetry → 真 telemetry-file-sink →
 *    **默认 PathManager 路径 `~/.forgeax/sessions/<sid>/logs/{trace,log}.jsonl`**(非测试目录)。
 * 末尾从该真实 .forgeax 路径回读并打印。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createForgeaxCoreKernel } from '../src/kernel/forgeax-core-adapter';
import { getPathManager } from '@forgeax/orchestrator/fs/path-manager';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

const MODEL = process.env.FORGEAX_E2E_MODEL || process.env.FORGEAX_MODEL || 'claude-opus-4-8';
const SID = `obs-real-${Date.now()}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function turnReq(prompt: string): TurnRequest {
  return {
    session: { threadId: `t-${Date.now()}`, agentId: 'forge' },
    callId: `c-${randomUUID()}`,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent. Answer in one word.', persona: '' },
    tools: [],
    budget: { maxTurns: 4 },
    model: MODEL,
    hostSessionId: SID,
    trustTier: 'own',
  } as TurnRequest;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[obs-real-e2e] 跳过:未设 ANTHROPIC_API_KEY(需 `set -a; source .env; set +a`)。');
    process.exit(0);
  }
  const logsDir = getPathManager().session(SID).logsDir();
  const traceFile = join(logsDir, 'trace.jsonl');
  const logFile = join(logsDir, 'log.jsonl');
  console.log(`[obs-real-e2e] model=${MODEL}  sid=${SID}`);
  console.log(`[obs-real-e2e] 预期落盘(真 .forgeax 路径): ${logsDir}\n`);

  const kernel = createForgeaxCoreKernel({}); // 真 adapter:默认 telemetrySink → PathManager .forgeax 路径
  const ac = new AbortController();
  const events: KernelEvent[] = [];

  console.log('runTurn(真模型,经真 server adapter → 真 serve 子进程)…');
  try {
    for await (const ev of kernel.runTurn(turnReq('Reply with exactly the word DONE.'), ac.signal)) {
      events.push(ev);
    }
  } catch (e) {
    console.log(`  runTurn error: ${(e as Error).message}`);
  }
  await sleep(600); // 等 sidecar 80ms coalesce + adapter 落盘

  console.log('\n================ 真 .forgeax 落盘回读 ================');
  console.log(`trace.jsonl: ${existsSync(traceFile) ? 'OK' : 'MISSING'}  →  ${traceFile}`);
  console.log(`log.jsonl  : ${existsSync(logFile) ? 'OK' : 'MISSING'}  →  ${logFile}`);

  const traceLines = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const logLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const finals = traceLines.map((l) => JSON.parse(l)).filter((s) => s.endTs != null);

  console.log(`\n[trace] ${traceLines.length} 行。final span:`);
  for (const s of finals.slice(0, 8)) {
    console.log(`  · ${String(s.name).padEnd(12)} trace=${String(s.traceId).slice(0, 12)} span=${String(s.spanId).slice(0, 8)} parent=${String(s.parentSpanId ?? '-').slice(0, 8)} dur=${(s.endTs - s.startTs).toFixed(1)}ms`);
  }
  console.log(`\n[log] ${logLines.length} 行:`);
  for (const l of logLines.slice(0, 10).map((x) => JSON.parse(x))) {
    console.log(`  · ${String(l.level).padEnd(5)} "${l.msg}" trace=${String(l.traceId ?? '-').slice(0, 12)}`);
  }

  const okSpans = finals.some((s) => s.name === 'agent.run');
  const okLogs = logLines.length > 0;
  const ids = new Set(traceLines.map((l) => JSON.parse(l).traceId));
  const corr = logLines.map((x) => JSON.parse(x)).some((l) => l.traceId && ids.has(l.traceId));
  console.log('\n================ 断言 ================');
  console.log(`  ${okSpans ? '✅' : '❌'} 真实 span 落到 .forgeax(含 agent.run)`);
  console.log(`  ${okLogs ? '✅' : '❌'} 真实 log 落到 .forgeax`);
  console.log(`  ${corr ? '✅' : '❌'} log↔trace 关联(log.traceId 命中 span)`);
  const ok = okSpans && okLogs && corr;
  console.log(`\n${ok ? '✅ 真生产路径 E2E 通过' : '❌ 失败'} · 落盘目录: ${logsDir}`);
  process.exit(ok ? 0 : 1);
}

void main();
