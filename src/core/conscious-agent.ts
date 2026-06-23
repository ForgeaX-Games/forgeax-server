/** ConsciousAgent —— LLM-driven agent with streaming turn loop.
 *
 *  与 agenteam ref `core/conscious-agent.ts`（650 行）的差异：
 *  - **不直接持 SessionManager**：ContextWindow 改吃 LedgerReader（C5 已落），
 *    `ledger` 由 caller（Session / SessionManager）通过 AgentInitConfig 注入。
 *  - **ContextEngine / kit registries 已接通**（B1.9，2026-05-20）：turn loop 里
 *    的 prompt 装配 + tool batch 默认走 BaseAgent 持有的 kits 子系统真实现 ——
 *      - `assemblePrompt` → `new ContextEngine(this.slotRegistry).assemblePrompt`
 *      - `getTools`      → `this.toolRegistry.list()` （visibility 已 wrap）
 *      - `runToolBatch`  → `kits/tool/tool-batch-runner.runToolBatch`
 *      - `refreshTools`  → `this.reloadKitKind("tools")`
 *    caller 仍可通过 ConsciousAgentInitConfig 注入 override（主要给测试 mock 用）。
 *    builtin/kits 目录空时这些默认 callback 行为退化为「空 tool 列表 + 空 system
 *    prompt + tool 调用直接拿空数组」，等价以前的 echo turn —— 不会因接通 kits
 *    导致空 builtin 场景 regression。
 *  - **ResolveModels**：用 `core/resolve-models.ts::resolveModelsConfig`，参数是
 *    `(agentJson, sessionDefaults)`，sessionDefaults 由 caller 注入（缺则 {})。
 *  - **logger**：用 `runWithAgentTurn` / `withModelFeedback`（已落 C7），不再
 *    `runWithAgentScope`（agent 持续期间外层由 Scheduler 负责进 scope）。
 *  - **withAgentJson watcher / FSWatcher**：AgentTree 已经监听整棵树，单 agent
 *    reload 由 Scheduler 显式触发 setAgentJson（保留在 BaseAgent）。
 *
 *  Turn loop 主结构、prepareInboundMessages 链、SystemSnapshot diff、
 *  breakpoint continuation、queueCommand 注入路径、abort 语义全部 1:1。 */

import { contentToString, normalizeContent } from "../message/modality";
import { stripThinkingBlocks } from "../llm/thinking";
import {
  assembleResponseWithCallback,
  getPartialResponse,
} from "../llm/stream";
import { isRetryable, isContextOverflowError } from "../llm/errors";
import { Hook } from "../hooks/types";
import {
  createFallbackProvider,
  getModelSpec,
} from "../llm/provider";
import { bareName } from "../utils/name-lookup";
import { BaseAgent, type AgentInitConfig as BaseAgentInitConfig } from "./base-agent";
import { runWithAgentTurn, withModelFeedback } from "./logger";
import { AGENT_DEFAULTS } from "../defaults/agent-json";
import { BLACKBOARD_KEYS } from "../defaults/blackboard-vars";
import { eventToSessionMessage } from "../message/message-ingress";
import { ContextWindow, type LedgerReader } from "../context-window/context-window";
import { compactCurrentSession } from "../context-window/summary-compaction";
import { diffSystemBlocks } from "../context-window/system-snapshot";
import { ModelRoutingHints } from "./model-routing";
import { resolveModelsConfig } from "./resolve-models";
import { sleep } from "../utils";
import { ContextEngine } from "../kits/slot/context-engine";
import { runToolBatch as runToolBatchKit } from "../kits/tool/tool-batch-runner";

import type {
  AgentContext,
  AgentJson,
  Event,
  ModelSpec,
  ModelsConfig,
  ToolDefinition,
} from "./types";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
  SystemBlock,
} from "../llm/types";

// ─── Caller-injected hooks (kit / context-engine 占位) ──────────────────────

/** Prompt assembler —— ContextEngine.assemblePrompt 的占位。
 *  返回 `{ system, messages }`，system=[] 时 ConsciousAgent 不发 SystemPrompt hook。 */
export interface PromptAssembler {
  (
    history: LLMMessage[],
    modelSpec: ModelSpec,
    vars: Record<string, string>,
  ): Promise<{ system: SystemBlock[]; messages: LLMMessage[] }> | { system: SystemBlock[]; messages: LLMMessage[] };
}

/** Tool batch runner —— capability/tool/tool-batch-runner 的占位。
 *  Echo turn 无 tool call 时永远走不到这里；kit 接进来后再把真正实现注入。 */
export interface ToolBatchRunner {
  (params: {
    toolCalls: LLMToolCall[];
    tools: ToolDefinition[];
    materializePending: (toolCalls: LLMToolCall[]) => LLMMessage[];
    materializeResult: (toolCall: LLMToolCall, result: unknown) => LLMMessage;
    turn: number;
    signal: AbortSignal;
  }): Promise<Array<{ toolCall: LLMToolCall; result: unknown }>>;
}

// ─── Reusable agent loop ────────────────────────────────────────────────────

export interface AgentLoopOpts {
  agentId: string;
  signal: AbortSignal;
  eventBus: import("./types").EventBusAPI;
  blackboard: import("./types").BlackboardAPI;
  /** Passed to ToolDefinition.condition to gate per-turn tool visibility. */
  agentContext?: AgentContext;
  provider: LLMProvider;
  getTools: () => ToolDefinition[];
  assemblePrompt: PromptAssembler;
  runToolBatch: ToolBatchRunner;
  modelSpec: ModelSpec;
  maxIterations: number;
  contextWindow: ContextWindow;
  turn?: number;
  onAssistantMessage?: (model?: string) => void;
  keepRecentTools?: number;
  keepRecentMedias?: number;
  idleGapMs?: number;
  showThinking?: boolean;
  absorbInnerLoopEvents?: () => Promise<boolean>;
  drainPendingCommands?: () => Promise<boolean>;
  refreshTools?: () => Promise<void>;
  /** 上下文超窗（prompt too long / 413）时的 reactive 救援。返回 true 表示已
   *  取得进展（compact 落了 boundary），loop 会 continue 重发本轮。缺省实现
   *  走 compactCurrentSession；测试注入 stub。 */
  reactiveOverflowRescue?: () => Promise<boolean>;
  timezone?: string;
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<LLMResponse | null> {
  const {
    agentId, signal, eventBus, blackboard,
    provider, getTools, assemblePrompt, runToolBatch,
    modelSpec, maxIterations, contextWindow,
  } = opts;
  const toolCtx = opts.agentContext;
  const turn = opts.turn ?? 0;

  return await runWithAgentTurn(agentId, turn, async () => {
    const {
      onAssistantMessage,
      keepRecentTools = AGENT_DEFAULTS.historyKeep.recentTools,
      keepRecentMedias = AGENT_DEFAULTS.historyKeep.recentMedias,
      idleGapMs,
      showThinking = false,
      absorbInnerLoopEvents: absorbInnerLoop,
    } = opts;

    const lifecycle = contextWindow;
    const MAX_EMPTY_RETRIES = 2;
    let iterations = 0;
    let emptyRetries = 0;
    let overflowRescueAttempted = false;
    let lastResponse: LLMResponse | null = null;

    const materializeAssistantMessage = (
      response: LLMResponse,
      options: { showThinking: boolean; ts: number; truncated?: boolean },
    ): LLMMessage => provider.materializeAssistantMessage!(response, options);

    const emitAssistant = (msg: LLMMessage, response?: LLMResponse): void => {
      eventBus.hook(Hook.AssistantMessage, {
        llmMessage: msg, turn,
        model: response?.model, usage: response?.usage, providerSidecarData: response?.providerSidecarData,
      });
      onAssistantMessage?.(response?.model);
    };

    const absorbInnerLoopEvents = absorbInnerLoop ?? (async () => false);

    // 上下文超窗 reactive 救援缺省实现：compact 当前 session，有进展返回 true。
    const reactiveRescue =
      opts.reactiveOverflowRescue ??
      (async (): Promise<boolean> => {
        if (!toolCtx?.ledger || !toolCtx.resolveModels) return false;
        try {
          const rescue = await compactCurrentSession({
            agentId,
            ledger: toolCtx.ledger,
            eventBus,
            resolveModels: toolCtx.resolveModels,
            signal,
          });
          if (rescue.ok !== false) {
            console.warn(
              `context overflow — reactive compact ${rescue.originalMessageCount} → ${rescue.newMessageCount} msgs, retrying turn`,
            );
            return true;
          }
          console.warn(`context overflow — reactive compact skipped: ${rescue.reason}`);
          return false;
        } catch (rescueErr: any) {
          console.warn(`context overflow — reactive compact failed: ${rescueErr?.message ?? rescueErr}`);
          return false;
        }
      });

    for (;;) {
      if (signal.aborted || (maxIterations !== -1 && iterations >= maxIterations)) break;
      iterations++;

      const sessionHistory = await contextWindow.buildPrompt({
        keepRecentTools, keepRecentMedias,
        idleGapMs,
        toolDefs: getTools(),
      });

      // Refresh CURRENT_TIME — 5-minute bucket to reduce delta churn (same
      // bucket = identical bytes = diffSystemBlocks returns null = no carrier).
      const FIVE_MIN_MS = 5 * 60 * 1000;
      const tz = opts.timezone ?? "Asia/Shanghai";
      const timeBucket = new Date(Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS);
      blackboard.set(
        agentId,
        "CURRENT_TIME",
        timeBucket.toLocaleString("zh-CN", { timeZone: tz }),
        { persist: false },
      );

      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(blackboard.getAll(agentId))) {
        vars[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      const { system, messages } = await assemblePrompt(sessionHistory, modelSpec, vars);

      if (system.length > 0) {
        const previousSnapshot = await lifecycle.buildSystemSnapshot();
        const delta = diffSystemBlocks(previousSnapshot, system);
        if (delta) {
          eventBus.hook(Hook.SystemPrompt, {
            changed: delta.changed,
            ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
          });
        }
      }

      const allTools = getTools();
      // Filter by condition before LLM call
      const tools = allTools.filter(t => !t.condition || t.condition(toolCtx as AgentContext, t));

      // LLM tool names must be bare. On bare-name collision, drop the whole
      // group + emit a model-visible warn.
      const byBare = new Map<string, ToolDefinition[]>();
      for (const t of tools) {
        const arr = byBare.get(bareName(t.name));
        if (arr) arr.push(t);
        else byBare.set(bareName(t.name), [t]);
      }
      const llmTools: ToolDefinition[] = [];
      for (const [bare, group] of byBare) {
        if (group.length === 1) { llmTools.push({ ...group[0], name: bare }); continue; }
        withModelFeedback(() => console.warn(
          `[ConsciousAgent] bare-name collision on "${bare}": ${group.map(t => t.name).join(", ")} — none exposed this turn; remove or rename one.`,
        ));
      }

      blackboard.set(agentId, BLACKBOARD_KEYS.ACTIVE_TOOLS,
        llmTools.map(t => ({ name: t.name, description: t.description })),
        { persist: false },
      );

      console.debug(`LLM call: ${messages.length} msgs, ${llmTools.length} tools, session=${sessionHistory.length}`);

      let response: LLMResponse;
      try {
        const stream = provider.chatStream(system.length > 0 ? system : undefined, messages, llmTools, signal);
        response = await assembleResponseWithCallback(stream, (event) => {
          eventBus.hook(Hook.StreamLLM, { chunk: event, turn });
        });
      } catch (err: any) {
        if (signal.aborted) {
          console.log("LLM call aborted");
          break;
        }
        console.error(`LLM call failed: ${err.message}`);
        const partialResponse = getPartialResponse(err);
        const partialText = partialResponse ? contentToString(partialResponse.content) : "";

        if (partialText.trim() || partialResponse?.thinking?.trim()) {
          emitAssistant(materializeAssistantMessage(
            { ...partialResponse!, toolCalls: undefined },
            { showThinking, truncated: true, ts: Date.now() },
          ), partialResponse);
        }

        // 上下文超窗（prompt too long / context_length_exceeded / 413）：原样
        // 重试必然再失败，但 compact 后可救。每次 runAgentLoop 只救一次：压缩
        // 成功 → continue 重发本轮（下一迭代 buildPrompt 会读到新 compact
        // boundary 之后的窗口）；压不动/再失败 → 按原路径收尾，turn 以错误收
        // 尾（不锁工具、不禁后续 turn —— 老项目 02.8「放行不锁死」教训）。
        if (!overflowRescueAttempted && isContextOverflowError(err)) {
          overflowRescueAttempted = true;
          if (await reactiveRescue()) continue;
        }

        if (isRetryable(err)) break;
        throw err;
      }

      // max_tokens 截断 + toolCalls 非空 = 半截 tool_use。args JSON 没生成完的
      // 已在 accumulator 丢弃；"凑巧完整"的（多个 tool_use 中靠前的）也一律不
      // 执行 —— 执行了它，截断点之后没生成出来的调用就永远丢了，且历史里会落
      // 一个与模型意图不符的半批执行。统一抑制 + 标 truncated，走下面的
      // breakpoint continuation 让模型重发完整调用（老项目 05.2 同款护栏）。
      if (!response.truncated && response.stopReason === "max_tokens") {
        if (response.toolCalls?.length) {
          console.warn(
            `max_tokens truncation with ${response.toolCalls.length} partial tool call(s) — suppressed, resuming via breakpoint continuation`,
          );
        }
        response = { ...response, toolCalls: undefined, truncated: true };
      }

      if (response.truncated) {
        console.log("LLM stream truncated (abort or max_tokens); saving partial response");
        const raw = contentToString(response.content);
        if (raw.trim() || response.thinking?.trim()) {
          const partialMsg = materializeAssistantMessage(response, {
            showThinking,
            truncated: true,
            ts: Date.now(),
          });
          emitAssistant(partialMsg, response);
        }
        // 回填 lastResponse —— process() 靠 `lastResponse?.truncated` 决定是否
        // 追加 breakpoint continuation 再跑一轮。abort 截断不会误续写：process()
        // 的 while 先查 signal.aborted。（此前这里不赋值，continuation 机制对
        // 所有路径都是死代码。）
        lastResponse = response;
        break;
      }

      const responseText = contentToString(response.content);
      const responseHasMedia = normalizeContent(response.content).some((part) => part.type !== "text");
      console.debug(
        `LLM response: content=${responseText ? responseText.length : responseHasMedia ? "multimodal" : 0} chars, tools=${response.toolCalls?.length ?? 0}`,
      );

      lastResponse = response;

      const assistantMsg = materializeAssistantMessage(response, {
        showThinking,
        ts: Date.now(),
      });

      if (signal.aborted) {
        assistantMsg.truncated = true;
        emitAssistant(assistantMsg, response);
        break;
      }

      const textContent = contentToString(assistantMsg.content);
      const displayContent = stripThinkingBlocks(textContent);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (!displayContent) {
          if (emptyRetries < MAX_EMPTY_RETRIES) {
            emptyRetries++;
            console.warn(`LLM returned empty response, retrying (${emptyRetries}/${MAX_EMPTY_RETRIES})`);
            continue;
          }
          console.log("LLM returned empty response (no content, no tool calls)");
        }
      }

      emitAssistant(assistantMsg, response);

      if (displayContent) {
        console.log(displayContent);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (await absorbInnerLoopEvents()) continue;
        if (await opts.drainPendingCommands?.()) continue;
        break;
      }

      emptyRetries = 0;

      await runToolBatch({
        toolCalls: response.toolCalls,
        tools: llmTools,
        materializePending: (toolCalls) =>
          provider.materializePendingToolMessages!(toolCalls, { ts: Date.now() }),
        materializeResult: (toolCall, result) =>
          provider.materializeToolResult!(toolCall, result, { ts: Date.now() }),
        turn,
        signal,
      });
      await opts.refreshTools?.();
      await opts.drainPendingCommands?.();
      await absorbInnerLoopEvents();
    }

    return lastResponse;
  });
}

// ─── ConsciousAgent ─────────────────────────────────────────────────────────

export interface ConsciousAgentInitConfig extends BaseAgentInitConfig {
  /** Per-agent ledger reader —— ContextWindow 用来读历史 events。 */
  ledger: LedgerReader;
  /** Session-level model defaults，缺则单独看 agent.json::models.model；
   *  resolveModelsConfig 把 agent + session 字段合并。 */
  sessionDefaultModels?: ModelsConfig;
  /** Prompt 装配回调；缺则用 identity（无 system block）。 */
  assemblePrompt?: PromptAssembler;
  /** Tool batch runner；缺则触发即报错（kit 没接进来时只能跑 echo turn）。 */
  runToolBatch?: ToolBatchRunner;
  /** Tool registry getter；缺则空数组。 */
  getTools?: () => ToolDefinition[];
  /** kit refresh 钩子（refreshTools），缺则跳过。 */
  refreshTools?: () => Promise<void>;
}

export class ConsciousAgent extends BaseAgent {
  private readonly provider: LLMProvider;
  readonly contextWindow: ContextWindow;
  private currentTurn = 0;
  private readonly modelRoutingHints: ModelRoutingHints;
  private readonly sessionDefaultModels: ModelsConfig;
  private readonly assemblePromptFn: PromptAssembler;
  private readonly runToolBatchFn: ToolBatchRunner;
  private readonly getToolsFn: () => ToolDefinition[];
  private readonly refreshToolsFn?: () => Promise<void>;

  get isTurnActive(): boolean {
    return !this.abortController.signal.aborted;
  }

  private commandQueue: Array<{ toolName: string; args: Record<string, string>; reason?: string }> = [];

  constructor(config: ConsciousAgentInitConfig) {
    super(config);
    this.modelRoutingHints = new ModelRoutingHints(this.agentPath);
    this.sessionDefaultModels = config.sessionDefaultModels ?? {};

    // 缺省回调走 BaseAgent 持有的 kits 子系统真实现（B1.9）：
    //   - assemblePrompt → ContextEngine over this.slotRegistry
    //   - runToolBatch  → kits/tool/tool-batch-runner（用 this.agentContext）
    //   - getTools      → this.toolRegistry.list()（已自动 wrap visibility）
    //   - refreshTools  → reload tools kind from disk on demand
    // 上述任一被 caller 显式注入时取代默认，方便测试 mock。
    const ctxEngine = new ContextEngine(this.slotRegistry);
    const defaultAssemble: PromptAssembler = (history, modelSpec, vars) =>
      ctxEngine.assemblePrompt(this.agentContext, history, modelSpec, undefined, vars);
    const defaultBatch: ToolBatchRunner = async (params) => {
      const outcomes = await runToolBatchKit({
        toolCalls: params.toolCalls,
        tools: params.tools,
        toolCtx: this.agentContext,
        materializePending: params.materializePending,
        materializeResult: params.materializeResult,
        turn: params.turn,
        // 必须透传 turn 捕获的 signal —— agentContext.signal 是惰性 getter，
        // abort 后下一 turn 换新 controller，kit 里再读就拿不到已 abort 的那个。
        signal: params.signal,
      });
      return outcomes.map((o) => ({ toolCall: o.toolCall, result: o.result }));
    };
    const defaultGetTools = (): ToolDefinition[] => this.toolRegistry.list();
    const defaultRefresh = async (): Promise<void> => {
      await this.reloadKitKind("tools");
    };

    this.assemblePromptFn = config.assemblePrompt ?? defaultAssemble;
    this.runToolBatchFn = config.runToolBatch ?? defaultBatch;
    this.getToolsFn = config.getTools ?? defaultGetTools;
    this.refreshToolsFn = config.refreshTools ?? defaultRefresh;

    const resolveModels = () => resolveModelsConfig(this.agentJson, this.sessionDefaultModels);

    this.provider = createFallbackProvider(
      () => this.modelRoutingHints.order(resolveModels()),
      {
        onRetry: (_model, info) => {
          const msg = `LLM 降级链全部失败，${info.delayMs}ms 后重试 (${info.attempt}/${info.maxRetries}): ${info.error.message}`;
          this.boundEventBus.hook(Hook.LLMRetry, { warning: msg });
        },
        onFallback: (from, to, error) => {
          this.modelRoutingHints.recordFallback(resolveModels(), from, error);
          const msg = `模型 ${from} 失败，回退到 ${to}: ${error.message}`;
          this.boundEventBus.hook(Hook.LLMFallback, { warning: msg });
        },
      },
    );

    this.contextWindow = new ContextWindow(this.agentPath, config.ledger, this.blackboard);

    // Expose compaction deps to kit tools/plugins (compact kit needs them).
    this.agentContext.ledger = config.ledger;
    this.agentContext.resolveModels = () => resolveModelsConfig(this.agentJson, this.sessionDefaultModels);

    this.watchAgentJson();
  }

  /** Public so Scheduler can drive the loop while holding lifecycle lock. */
  async run(_signal: AbortSignal): Promise<void> {
    while (!this.shuttingDown) {
      if (this.abortController.signal.aborted) {
        this.abortController = new AbortController();
      }
      const turnSignal = this.abortController.signal;

      while (this.commandQueue.length > 0 && !turnSignal.aborted) {
        const cmd = this.commandQueue.shift()!;
        this.currentTurn++;
        try {
          await runWithAgentTurn(this.agentPath, this.currentTurn, async () => {
            await this.executeCommand(cmd.toolName, cmd.args, cmd.reason, turnSignal);
          });
        } catch (err: any) {
          if (!turnSignal.aborted) {
            withModelFeedback(() => console.error(`command failed: ${err?.message ?? err}`));
          }
        }
      }
      if (turnSignal.aborted) continue;

      let trigger: Event;
      try {
        trigger = await this.queue.waitForEvent(turnSignal);
      } catch {
        continue;
      }

      if (this.queue.hasHandoff("steer")) {
        // Skip coalesce for steer events — process immediately
      } else if ((trigger.priority ?? 1) > 0 && this.coalesceMs > 0) {
        await sleep(this.coalesceMs, turnSignal);
      }

      const events = this.queue.drain().filter((e) => eventToSessionMessage(e) !== null);
      if (events.length === 0) continue;

      this.currentTurn++;

      const steerWatcher = this.queue.onSteer(() => {
        this.abortController.abort();
      });

      console.log(`▶ process [${events.length} events]`);

      try {
        await runWithAgentTurn(this.agentPath, this.currentTurn, async () => {
          await this.process(events, turnSignal);
        });
      } catch (err: any) {
        if (turnSignal.aborted) {
          console.log("turn aborted");
        } else {
          withModelFeedback(() => console.error(`process failed: ${err?.message ?? err}`));
        }
      } finally {
        steerWatcher.dispose();
      }
    }
  }

  private async prepareInboundMessages(
    events: Event[], signal: AbortSignal,
  ): Promise<{ msg: LLMMessage; event: Event }[]> {
    const results: { msg: LLMMessage; event: Event }[] = [];
    for (const event of events) {
      const inboundMsg = eventToSessionMessage(event);
      if (!inboundMsg) continue;
      const prepared = await this.provider.prepareInboundMessages!([inboundMsg], { signal });
      for (const msg of prepared) {
        results.push({ msg, event });
      }
    }
    return results;
  }

  private async process(events: Event[], signal: AbortSignal): Promise<void> {
    if (events.length === 0) return;

    this.contextWindow.trackEvents(events);

    this.blackboard.set(this.agentPath, BLACKBOARD_KEYS.RUNNING, true, { persist: false });
    this.boundEventBus.hook(Hook.TurnStart, { turn: this.currentTurn, eventCount: events.length });
    let turnError: string | undefined;

    try {
      for (const { msg, event } of await this.prepareInboundMessages(events, signal)) {
        this.boundEventBus.publish({
          source: event.source,
          type: "inbound_message",
          payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
          ts: Date.now(),
        });
      }

      const MAX_CONTINUATIONS = this.agentJson.models?.maxRetries ?? AGENT_DEFAULTS.models.maxRetries;
      let continuationRetries = 0;

      while (!signal.aborted && continuationRetries < MAX_CONTINUATIONS) {
        const mc = this.modelRoutingHints.order(
          resolveModelsConfig(this.agentJson, this.sessionDefaultModels),
        );
        const currentModel = Array.isArray(mc.model) ? mc.model[0] : (mc.model ?? "");
        const lastResponse = await runAgentLoop({
          agentId: this.agentPath,
          signal,
          eventBus: this.boundEventBus,
          blackboard: this.blackboard,
          provider: this.provider,
          getTools: this.getToolsFn,
          assemblePrompt: this.assemblePromptFn,
          runToolBatch: this.runToolBatchFn,
          agentContext: this.agentContext,
          modelSpec: getModelSpec(currentModel),
          maxIterations: this.agentJson.maxIterations ?? AGENT_DEFAULTS.maxIterations,
          contextWindow: this.contextWindow,
          turn: this.currentTurn,
          onAssistantMessage: (model) =>
            this.modelRoutingHints.recordSuccess(
              resolveModelsConfig(this.agentJson, this.sessionDefaultModels),
              model,
            ),
          keepRecentTools: this.agentJson.historyKeep?.recentTools ?? AGENT_DEFAULTS.historyKeep.recentTools,
          keepRecentMedias: this.agentJson.historyKeep?.recentMedias ?? AGENT_DEFAULTS.historyKeep.recentMedias,
          idleGapMs: this.agentJson.historyKeep?.idleGapMs ?? AGENT_DEFAULTS.historyKeep.idleGapMs,
          showThinking: this.agentJson.models?.showThinking ?? true,
          refreshTools: this.refreshToolsFn,
          absorbInnerLoopEvents: async () => {
            const innerEvents = this.queue.drain((e) => (e.handoff ?? "turn") === "innerLoop");
            if (!innerEvents.length) return false;
            for (const { msg, event } of await this.prepareInboundMessages(innerEvents, signal)) {
              this.boundEventBus.publish({
                source: event.source,
                type: "inbound_message",
                payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
                ts: Date.now(),
              });
            }
            console.debug(`absorbed ${innerEvents.length} innerLoop events into current turn`);
            return true;
          },
          drainPendingCommands: async () => {
            if (this.commandQueue.length === 0) return false;
            while (this.commandQueue.length > 0 && !signal.aborted) {
              const cmd = this.commandQueue.shift()!;
              const tools = this.getToolsFn();
              const tool = tools.find((t) => t.name === cmd.toolName || bareName(t.name) === cmd.toolName);
              if (!tool) {
                console.warn(`command: unknown tool '${cmd.toolName}'`);
                continue;
              }
              const callId = `cmd_${Date.now()}`;
              const toolCall: LLMToolCall = { id: callId, name: cmd.toolName, arguments: cmd.args };

              const assistantMsg = this.provider.materializeAssistantMessage!(
                { content: cmd.reason ?? `Executing: ${cmd.toolName}`, toolCalls: [toolCall] },
                { showThinking: true, ts: Date.now() },
              );
              this.boundEventBus.hook(Hook.AssistantMessage, { llmMessage: assistantMsg, turn: this.currentTurn });

              await this.runToolBatchFn({
                toolCalls: [toolCall],
                tools,
                materializePending: (tcs) =>
                  this.provider.materializePendingToolMessages!(tcs, { ts: Date.now() }),
                materializeResult: (tc, r) =>
                  this.provider.materializeToolResult!(tc, r, { ts: Date.now() }),
                turn: this.currentTurn,
                signal,
              });
              if (this.refreshToolsFn) await this.refreshToolsFn();
              console.log(`command /${cmd.toolName} drained in agent loop`);
            }
            return true;
          },
          timezone: this.agentJson.timezone,
        });

        if (!lastResponse?.truncated) break;

        continuationRetries++;
        console.warn(`breakpoint continuation (${continuationRetries}/${MAX_CONTINUATIONS})`);

        const continueEvent: Event = {
          source: `agent:${this.agentPath}`,
          type: "breakpoint_continuation",
          payload: {
            content:
              "Continue from where you left off. " +
              "Do not repeat any previously generated content. " +
              "If you were generating a tool call, re-issue it completely.",
          },
          ts: Date.now(),
        };
        for (const { msg, event } of await this.prepareInboundMessages([continueEvent], signal)) {
          this.boundEventBus.publish({
            source: event.source,
            type: "inbound_message",
            payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
            ts: Date.now(),
          });
        }

        await sleep(1500, signal);
      }
    } catch (err: any) {
      if (!signal.aborted) {
        turnError = err?.message ?? String(err);
        console.error(`process failed: ${turnError}`);
      }
    } finally {
      this.boundEventBus.hook(Hook.TurnEnd, { turn: this.currentTurn, aborted: signal.aborted, error: turnError });
      this.blackboard.set(this.agentPath, BLACKBOARD_KEYS.RUNNING, false, { persist: false });
    }
  }

  private async executeCommand(
    toolName: string, args: Record<string, string>, reason: string | undefined, signal: AbortSignal,
  ): Promise<void> {
    const tools = this.getToolsFn();
    const tool = tools.find((t) => t.name === toolName || bareName(t.name) === toolName);
    if (!tool) {
      console.warn(`command: unknown tool '${toolName}'`);
      return;
    }

    const callId = `cmd_${Date.now()}`;
    const toolCall: LLMToolCall = { id: callId, name: toolName, arguments: args };

    const commandEvent: Event = {
      source: `agent:${this.agentPath}`,
      type: "agent_command",
      payload: { content: reason ?? toolName, toolName },
      ts: Date.now(),
    };
    for (const { msg, event } of await this.prepareInboundMessages([commandEvent], signal)) {
      this.boundEventBus.publish({
        source: event.source,
        type: "inbound_message",
        payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
        ts: Date.now(),
      });
    }

    const assistantMsg: LLMMessage = this.provider.materializeAssistantMessage!(
      {
        content: reason ?? `Executing: ${toolName}`,
        toolCalls: [toolCall],
      },
      { showThinking: true, ts: Date.now() },
    );
    this.boundEventBus.hook(Hook.AssistantMessage, { llmMessage: assistantMsg, turn: this.currentTurn });

    this.blackboard.set(this.agentPath, BLACKBOARD_KEYS.RUNNING, true, { persist: false });
    this.boundEventBus.hook(Hook.TurnStart, { turn: this.currentTurn, eventCount: 1 });
    let results: Awaited<ReturnType<ToolBatchRunner>>;
    try {
      results = await this.runToolBatchFn({
        toolCalls: [toolCall],
        tools,
        materializePending: (toolCalls) =>
          this.provider.materializePendingToolMessages!(toolCalls, { ts: Date.now() }),
        materializeResult: (pendingToolCall, result) =>
          this.provider.materializeToolResult!(pendingToolCall, result, { ts: Date.now() }),
        turn: this.currentTurn,
        signal,
      });
    } catch (err: any) {
      if (!signal.aborted) {
        withModelFeedback(() => console.error(`command failed: ${err?.message ?? err}`));
      }
      return;
    } finally {
      this.boundEventBus.hook(Hook.TurnEnd, { turn: this.currentTurn, aborted: signal.aborted });
      this.blackboard.set(this.agentPath, BLACKBOARD_KEYS.RUNNING, false, { persist: false });
    }

    const result = results[0]?.result;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    console.log(`command /${toolName} → ${resultStr.slice(0, 200)}`);
  }

  queueCommand(toolName: string, args: Record<string, string>, reason?: string, interrupt = true): void {
    this.commandQueue.push({ toolName, args, reason });
    if (interrupt) this.abortController.abort();
  }
}

// 缺省回调（assemblePrompt / runToolBatch / getTools / refreshTools）现在由
// constructor 用 BaseAgent kits 子系统建：ContextEngine + tool-batch-runner +
// toolRegistry.list() + reloadKitKind("tools")。caller 注入是可选 override。

/** Re-export for callers that previously imported from this file. */
export { resolveModelsConfig };
