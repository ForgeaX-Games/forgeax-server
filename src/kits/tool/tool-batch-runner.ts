/** Batch tool runner —— execute LLM tool calls with concurrency-aware scheduling.
 *
 *  Partition：
 *    [C, C, S, C] → [[C,C], [S], [C]]
 *    Consecutive concurrent-safe calls (`tool.serial !== true`) merge into
 *    one parallel batch; any `serial === true` (or undefined) stands alone.
 *    Default policy: **serial unless tool opts-in via `serial: false`**.
 *
 *  Hook semantics（与 ref 一致）：
 *    - `Hook.ToolCall + ":pending"` —— materialize 出 LLM pending tool_use
 *      消息后立刻 emit，UI 可以提前画出"调用中"骨架。
 *    - `Hook.ToolCall` —— 每次 dispatch 前 emit；handler 可 `event.block()`
 *      让 tool 不被 execute，直接拿 hook 返回的 blockReason 作为结果。
 *    - `Hook.ToolResult` —— commit 时 emit，带 llmMessage / durationMs /
 *      可选 visual_display / error。
 *
 *  Ported from `agenteam-os-ref/src/capability/tool/tool-batch-runner.ts`. */

import type { ToolDefinition, AgentContext, ToolOutput } from "../../core/types";
import type { LLMToolCall, LLMMessage } from "../../llm/types";
import { Hook } from "../../hooks/types";
import { executeTool, resolveTool } from "./tool-executor";

type ResultOrError = ToolOutput | { error: string };

function partition(toolCalls: LLMToolCall[], tools: ToolDefinition[]) {
  const batches: { serial: boolean; calls: LLMToolCall[] }[] = [];
  for (const tc of toolCalls) {
    // 与 ref 一致：默认 serial。tool 显式 `serial: false` 才进入并发桶。
    const serial = resolveTool(tc.name, tools)?.serial !== false;
    if (serial) {
      batches.push({ serial: true, calls: [tc] });
    } else {
      const last = batches.at(-1);
      if (last && !last.serial) last.calls.push(tc);
      else batches.push({ serial: false, calls: [tc] });
    }
  }
  return batches;
}

export interface RunToolBatchParams {
  toolCalls: LLMToolCall[];
  tools: ToolDefinition[];
  toolCtx: AgentContext;
  materializePending: (toolCalls: LLMToolCall[]) => LLMMessage[];
  materializeResult: (toolCall: LLMToolCall, result: unknown) => LLMMessage;
  turn: number;
  /** 当前 turn 的 abort signal。abort 一触发，正在执行/尚未执行的 call 全部
   *  立即以中断 error 提交（不等工具 promise 返回）——保证 turn 一定能收尾、
   *  TurnEnd 一定发出，UI 终止永不被单个工具挂死。**必须传 turn 自己捕获的
   *  signal** 而不是惰性读 toolCtx.signal —— BaseAgent 在 abort 后的下一个
   *  turn 会换新 AbortController，getter 届时指向新（未 abort）的 signal。 */
  signal?: AbortSignal;
}

export interface ToolBatchOutcome {
  toolCall: LLMToolCall;
  result: ResultOrError;
  durationMs: number;
}

export async function runToolBatch(params: RunToolBatchParams): Promise<ToolBatchOutcome[]> {
  const { toolCalls, tools, toolCtx, materializePending, materializeResult } = params;
  if (toolCalls.length === 0) return [];

  const signal = params.signal ?? toolCtx.signal;

  // boundEventBus.hook is BaseAgent-provided; raw EventBusAPI doesn't carry
  // `hook`. Cast at the boundary —— BaseAgent guarantees this shape inside
  // agentContext.eventBus.
  const hookBus = toolCtx.eventBus as unknown as {
    hook<T extends string>(
      type: T,
      payload: Record<string, unknown>,
    ): { isBlocked?: () => boolean; blockReason?: string };
  };

  // 1) Materialize pending tool_use messages —— let UI render "pending".
  for (const msg of materializePending(toolCalls)) {
    hookBus.hook(`${Hook.ToolCall}:pending`, { llmMessage: msg });
  }

  // 2) Dispatch helper —— hook fires, observers can short-circuit via block().
  const dispatch = async (tc: LLMToolCall): Promise<ResultOrError> => {
    const evt = hookBus.hook(Hook.ToolCall, {
      name: tc.name,
      args: tc.arguments,
      toolCall: tc,
      toolCallId: tc.id,
    });
    if (evt.isBlocked?.()) {
      return { error: evt.blockReason ?? "Blocked by hook observer" };
    }
    return executeTool(tc.name, tc.arguments, tools, toolCtx);
  };

  // 2.5) Abort-race wrapper —— abort signal 触发即返回中断 error，不等工具
  // promise（它可能因 bug / 外部依赖永远不返回，绝不能让它挂死整个 turn）。
  // 已 abort 时直接短路，工具根本不 dispatch。被放弃的 in-flight promise
  // 继续在后台跑完（无法取消任意 promise），其结果/异常被吞掉不再 commit。
  const ABORT_ERROR = "(aborted) 用户中断,工具执行被放弃";
  const dispatchAbortable = (tc: LLMToolCall): Promise<ResultOrError> => {
    if (signal?.aborted) return Promise.resolve({ error: ABORT_ERROR });
    const run = dispatch(tc).catch(
      (err): ResultOrError => ({ error: (err as Error)?.message ?? String(err) }),
    );
    if (!signal) return run;
    return new Promise<ResultOrError>((resolve) => {
      const onAbort = () => resolve({ error: ABORT_ERROR });
      signal.addEventListener("abort", onAbort, { once: true });
      void run.then((r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
    });
  };

  // 3) Commit helper —— emit ToolResult hook with materialized result message.
  const commit = async (tc: LLMToolCall, result: ResultOrError, durationMs: number): Promise<void> => {
    const toolDef = resolveTool(tc.name, tools);
    let visualDisplay: string | undefined;
    if (toolDef?.formatDisplay) {
      try {
        // formatDisplay's signature uses ToolOutput; pass result as-is —
        // tool authors handle the `{ error }` shape themselves when needed.
        visualDisplay = toolDef.formatDisplay(tc.arguments, result as ToolOutput);
      } catch (err) {
        process.stderr.write(
          `[ToolBatchRunner] formatDisplay(${tc.name}) failed: ${(err as Error)?.message}\n`,
        );
      }
    }
    const toolError =
      result && typeof result === "object" && "error" in (result as Record<string, unknown>)
        ? String((result as Record<string, unknown>).error)
        : undefined;

    hookBus.hook(Hook.ToolResult, {
      llmMessage: materializeResult(tc, result),
      name: tc.name,
      durationMs,
      toolCallId: tc.id,
      ...(visualDisplay ? { visual_display: visualDisplay } : {}),
      ...(toolError ? { error: toolError } : {}),
    });
    console.debug(`tool batch commit: ${tc.name} (${durationMs}ms)`);
  };

  // 4) Run partitioned batches —— serial waits, concurrent runs Promise.all.
  // 每个 call 都走 dispatchAbortable：abort 后剩余 call 不执行但仍 commit 中断
  // error 结果，保持 tool_use ↔ tool_result 配对完整（LLM 历史一致性）。
  const all: ToolBatchOutcome[] = [];
  for (const batch of partition(toolCalls, tools)) {
    if (batch.serial) {
      const tc = batch.calls[0]!;
      const t0 = Date.now();
      const result = await dispatchAbortable(tc);
      const durationMs = Date.now() - t0;
      await commit(tc, result, durationMs);
      all.push({ toolCall: tc, result, durationMs });
    } else {
      const runs = batch.calls.map(async (tc) => {
        const t0 = Date.now();
        const result = await dispatchAbortable(tc);
        const durationMs = Date.now() - t0;
        await commit(tc, result, durationMs);
        return { toolCall: tc, result, durationMs };
      });
      all.push(...(await Promise.all(runs)));
    }
  }

  return all;
}
