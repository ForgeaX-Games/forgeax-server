/** POST /api/cli/chat —— 临时 SSE 桥，让 interface 还能跟 claude-code 聊天。
 *
 *  R3 阶段定位（参考 docs/features/internal-loop-completion-plan.md §5）：
 *  - **独立 REST 分支**，不走 commands transport。
 *  - 标 `Deprecation: true` + `Sunset: forgeax-v1.0` —— 等原生 ScriptAgent /
 *    commands `attach_script_agent` 跑通后，这条整片下线。
 *  - 简化版砍掉旧实现的 runs / threads / event-log / SessionStore 持久化层；
 *    只保留 "POST 一句话 → SSE 一回合 → done/error 终止" 的最小核心。多轮上下文
 *    继续靠 claude-code 自带的 `--session-id` / `--resume`（provider 内部维持
 *    `startedThreadIds` set），threadId 由 caller（interface）提供。
 *
 *  请求体（与旧 chat.ts 子集兼容）：
 *    {
 *      message: string,           // 必填
 *      threadId?: string,         // UUID v4；缺则 provider 每次起独立 session（无续上下文）
 *      agentId?: string,          // 暂时只用于日志
 *      providerOverride?: string  // 当前只 claude-code 一家，无效；保留字段兼容旧 UI
 *    }
 *
 *  响应：text/event-stream，每条事件 `event: <type>\ndata: <json>\n\n`。
 *  事件类型来自 ChatEvent union（token / thinking / tool-call / tool-result / done / error）。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getDefaultProvider,
  getProvider,
  listProviders,
} from "../../cli-providers/registry";
import type { ChatEvent, ChatRequest } from "../../cli-providers/types";
import { deprecation } from "../lib/deprecation";
import { getSessionManager } from "../../core/session-manager";
import { getPathManager } from "../../fs/path-manager";
import { CliEventBridge } from "../../observatory/cli-event-bridge";
import { denyPermissionsForSession, awaitPermissionDecision } from "../../core/permission-registry";
import { lookupCursorSession } from "../../cli-providers/providers/cursor-agent";

interface ChatBody {
  message?: string;
  agentId?: string;
  threadId?: string;
  sessionId?: string;
  providerOverride?: string;
  /** Doc 05 section 7 -- per-call id for `POST /api/cli/cancel`. */
  callId?: string;
  /** Doc 05 section 7 -- per-call deadline; the provider auto-aborts and
   *  surfaces `code: 'driver-timeout'` on expiry. */
  timeoutMs?: number;
}

interface CancelBody {
  callId?: string;
  providerOverride?: string;
}

const DEPRECATION_NOTICE = deprecation({
  sunset: "forgeax-v1.0",
  reason: "cli-provider bridge is temporary; will be replaced by commands.attach_script_agent + ScriptAgent",
  migration: "/api/commands/attach_script_agent/execute (planned R5)",
});

export function createCliRouter() {
  const r = new Hono();

  // 所有 /api/cli/* 端点统一带 Deprecation header。
  r.use("*", DEPRECATION_NOTICE);

  // 健康检查 —— 让 interface 能 probe "claude 二进制有没有 / API key 设了没"。
  r.get("/health", async (c) => {
    const providers = listProviders();
    if (providers.length === 0) {
      return c.json({ ok: false, providers: [], detail: "no cli-provider registered" }, 503);
    }
    const snaps = await Promise.all(providers.map(async (p) => {
      const h = await p.health(1500);
      return { id: p.id, ok: h.ok, detail: h.detail, capabilities: p.capabilities };
    }));
    return c.json({ ok: snaps.every((s) => s.ok), providers: snaps });
  });

  r.post("/chat", async (c) => {
    let body: ChatBody;
    try {
      body = (await c.req.json()) as ChatBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const message = body?.message;
    if (typeof message !== "string" || !message.trim()) {
      return c.json({ ok: false, error: "message (non-empty string) required" }, 400);
    }

    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }

    // Pre-flight health —— 避免开了 SSE 才报 "claude 二进制找不到"。
    const h = await provider.health(1500);
    if (!h.ok) {
      return c.json({ ok: false, error: h.detail ?? `provider ${provider.id} unhealthy` }, 503);
    }

    const req: ChatRequest = {
      agentId: body.agentId ?? "default",
      message,
      threadId: body.threadId,
      sessionId: body.sessionId,
      callId: typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined,
      timeoutMs: typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined,
    };

    // Stamp the resolved provider on the response stream so the cancel route
    // (which only sees callId) can short-circuit when the registry shape
    // changes mid-flight; the lifecycle wrapper inside provider.chat is the
    // one that actually owns the AbortController.
    // Observatory bridge — when the caller passes a forgeax sessionId we
    // also publish a translated copy of every ChatEvent onto the session's
    // EventBus so per-agent ledger persistence + observatory live SSE both
    // see the same turn. Skipped when sessionId is missing (legacy callers)
    // or the session can't be opened.
    let bridge: CliEventBridge | null = null;
    if (req.sessionId) {
      try {
        const session = await getSessionManager().open(req.sessionId);
        const node = session.tree.list().find((n) => n.display === req.agentId)
          ?? session.tree.list().find((n) => n.depth === 1)
          ?? null;
        const agentPath = node?.path ?? req.agentId;
        bridge = new CliEventBridge({ session, agentPath, model: provider.id });

        // Per-agent model selection: the ModelPicker writes the user's choice to
        // `agent.json::models.model` (via the `set_agent_models` command). That
        // file is the SSOT the forgeax runtime already consumes — but the
        // cli-provider bridge built `req` without it, so providers like
        // claude-code fell back to the CLI's built-in default (looked like the
        // picker "did nothing"). Resolve it here and forward as a provider
        // override (types.ts: `options` = "provider-specific overrides … model")
        // so the selected model actually reaches whichever provider runs.
        // Candidate paths: prefer the exact agentPath the ModelPicker wrote to
        // (req.agentId — the UI sends the active tab's agent path, which is the
        // same value `set_agent_models` keys on), then the tree-resolved path.
        // First candidate that yields a models.model wins.
        const pm = getPathManager();
        const candidates = Array.from(new Set([req.agentId, agentPath].filter(Boolean)));
        for (const cand of candidates) {
          try {
            const cfg = JSON.parse(await Bun.file(pm.session(req.sessionId).agent(cand).agentJson()).text()) as {
              models?: { model?: string | string[] | null };
            };
            const raw = cfg.models?.model;
            const model = Array.isArray(raw)
              ? raw.find((m) => typeof m === "string" && m.trim())?.trim()
              : typeof raw === "string" && raw.trim()
                ? raw.trim()
                : undefined;
            if (model) { req.options = { ...(req.options ?? {}), model }; break; }
          } catch {
            /* this candidate has no agent.json / unreadable → try next */
          }
        }
      } catch (e) {
        console.warn(`[cli/chat] observatory bridge skipped: ${(e as Error).message}`);
      }
    }

    return streamSSE(c, async (sse) => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      c.req.raw.signal.addEventListener("abort", onAbort);

      bridge?.start();
      let endStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' = 'end_turn';
      let endDurationMs: number | undefined;
      let endUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
      let endEmitted = false;
      const finishBridge = () => {
        if (!bridge || endEmitted) return;
        endEmitted = true;
        bridge.end(endStopReason, endDurationMs, endUsage);
      };

      try {
        for await (const ev of provider.chat(req, ac.signal)) {
          // 把 providerId 也回写到事件（旧实现里在 mapper 出口已经 stamped；这里
          // 兼容性兜底）。
          const out: ChatEvent = { ...ev, providerId: ev.providerId ?? provider.id };
          await sse.writeSSE({
            event: out.type,
            data: JSON.stringify(out),
          });
          if (bridge) {
            if (out.type === 'done') {
              endStopReason = out.stopReason;
              endDurationMs = out.durationMs;
              endUsage = out.usage;
            } else if (out.type === 'error') {
              endStopReason = 'cancelled';
            }
            bridge.forward(out);
          }
          if (out.type === "done" || out.type === "error") break;
        }
      } catch (err: any) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", message: err?.message ?? String(err), providerId: provider.id }),
        });
        endStopReason = 'cancelled';
      } finally {
        finishBridge();
        // A blocked permission card belongs to THIS turn. When the turn ends
        // (naturally, on error, or because the user cancelled / sent a new
        // message → the subprocess is terminated, which also kills the MCP
        // permission child and drops its HTTP call), release any permission
        // still pending for this thread. The held /permission-request then
        // resolves fail-closed *now* and its finally publishes
        // `permission:resolved` → the UI card dismisses — instead of lingering
        // for 10 minutes against a turn whose subprocess is already gone.
        // sid + agent recompute exactly what claude-code.ts fed the MCP server
        // (FORGEAX_SID / FORGEAX_AGENT). No-op on a normal turn (the answered
        // request was already removed from the registry).
        const permSid = req.threadId?.trim() || req.sessionId?.trim() || "";
        if (permSid) {
          try {
            denyPermissionsForSession(permSid, req.agentId?.trim() || "forge");
          } catch (e) {
            console.warn(`[cli/chat] permission cleanup failed: ${(e as Error).message}`);
          }
        }
        c.req.raw.signal.removeEventListener("abort", onAbort);
      }
    });
  });

  // POST /api/cli/cancel -- Doc 05 section 7 cancel channel. Calls
  // provider.cancel(callId) so the in-flight chat aborts and emits its
  // `{ type: 'done', stopReason: 'cancelled', code: 'cancelled' }` terminal
  // on its own SSE stream. Idempotent: unknown callIds return ok:true so
  // the UI can fire-and-forget without races against natural completion.
  r.post("/cancel", async (c) => {
    let body: CancelBody;
    try {
      body = (await c.req.json()) as CancelBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    if (!callId) {
      return c.json({ ok: false, error: "callId (non-empty string) required" }, 400);
    }
    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }
    if (typeof provider.cancel !== "function") {
      return c.json({ ok: false, error: `provider ${provider.id} does not support cancel` }, 501);
    }
    try {
      await provider.cancel(callId);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 500);
    }
    return c.json({ ok: true, callId, providerId: provider.id });
  });

  // POST /api/cli/cursor-permission —— cursor-agent 审批回执端。cursor 的
  // .cursor/hooks.json 没法把 forgeax sid 烤进去(无 --hooks 路径参数),所以
  // hook(cursor-permission-hook.mjs)POST 过来的是 cursor 自己的 chat id;这里
  // 经 CursorAgentProvider 的 cursorSession→forgeax 映射翻回前端在看的 sid,再走
  // 与 claude-code/codex 完全相同的 awaitPermissionDecision 弹同一张卡。映射未命中
  // (turn 已结束/未注册)→ fail-closed(deny)。
  r.post("/cursor-permission", async (c) => {
    let body: { cursorSessionId?: string; toolName?: string; command?: string; input?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ allow: false }, 400);
    }
    const cursorSessionId = typeof body.cursorSessionId === "string" ? body.cursorSessionId.trim() : "";
    const ctx = cursorSessionId ? lookupCursorSession(cursorSessionId) : undefined;
    if (!ctx) return c.json({ allow: false });
    const { allow } = await awaitPermissionDecision({
      sid: ctx.sid,
      agent: ctx.agent,
      toolName: typeof body.toolName === "string" && body.toolName ? body.toolName : "Bash",
      command: typeof body.command === "string" ? body.command : "",
      input: body.input ?? null,
    });
    return c.json({ allow });
  });

  return r;
}
