// CodexProvider — OpenAI Codex CLI (`codex`) backend.
//
// PRIMARY path: drives a `codex app-server` (newline JSON-RPC 2.0 over stdio)
// per turn, which gives us a real interactive APPROVAL loop — codex sends
// `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
// server-requests, we route them to the SAME Studio approval card the
// claude-code provider uses (core/permission-registry.ts::awaitPermissionDecision)
// and reply `{decision:"accept"|"decline"}`. It also streams agent text
// incrementally (item/agentMessage/delta → token), unlike the legacy one-shot
// `codex exec --json` which returned the whole reply at the very end.
//
// FALLBACK path: if `codex app-server` can't start (older codex / experimental
// protocol drift), we fall back to the legacy `codex exec --json` (no approval,
// no incremental streaming) so codex at least still chats. Loud-warned.
//
// Game-dev parity: forgeax game charter + active-game note + persona are passed
// as the thread's `developerInstructions` at thread/start (proper system-prompt
// channel — so "hello" is treated as chat, not as a build command). Sandbox is
// `workspace-write` + approvalPolicy `on-request`, the codex analogue of
// claude-code's acceptEdits: in-workspace ops run smoothly, only escalations
// (out-of-workspace / network / risky) pop the approval card.

import type {
  CliProvider,
  ChatEvent,
  ChatRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderHealth,
} from '../types';
import { spawnJsonl } from '../shared/subprocess-jsonl';
import {
  createCodexMapperState,
  flushCodexMapper,
  mapCodexEvent,
  type CodexRawEvent,
} from '../shared/codex-mapper';
import { friendlyPath } from '../../api/lib/friendly-path';
import { resolveBinary } from '../shared/resolve-binary';
import { sessionDefaultDir } from '../shared/scope-slug';
import { defaultProjectRoot } from '../../api/lib/safe-path';
import { getActiveGame } from '../../api/lib/active-game';
import { resolveRoute } from '../key-registry';
import { composeSystemPrompt } from '../../agents/loader';
import { buildGameCharter, buildActiveGameNote } from '../../agents/game-charter';
import { createCallTracker, withCallLifecycle } from '../shared/call-lifecycle';
import { CodexAppServerClient, type ServerRequest } from '../shared/codex-appserver-client';
import { awaitPermissionDecision } from '../../core/permission-registry';
import { FORGEAX_TOOLS_MCP_NAME, forgeaxToolsServerEntry } from '../shared/forgeax-tools-mcp';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';
const INTERFACE_PORT = process.env.FORGEAX_INTERFACE_PORT ?? '18920';

const FORGEAX_SYSTEM_PROMPT = buildGameCharter({
  serverPort: SERVER_PORT,
  interfacePort: INTERFACE_PORT,
});

/** Register the forgeax-tools MCP server (wb-bgm audio library, …) as codex
 *  global `-c` config overrides so BOTH paths (app-server + exec) expose the
 *  host tools — codex's analogue of claude's `--mcp-config` / cursor's
 *  `.cursor/mcp.json`. `agentId` is forwarded (FORGEAX_AGENT) so the MCP filters
 *  host tools to this agent's whitelist. Values are TOML (a JSON string is a
 *  valid TOML basic string for our ascii paths/urls). These argv elements
 *  precede the subcommand, where codex reads global flags. */
function forgeaxMcpConfigArgs(agentId?: string): string[] {
  const entry = forgeaxToolsServerEntry(import.meta.dir, process.execPath, SERVER_PORT, agentId);
  const toml = (s: string) => JSON.stringify(s);
  const prefix = `mcp_servers.${FORGEAX_TOOLS_MCP_NAME}`;
  const argsToml = `[${entry.args.map(toml).join(', ')}]`;
  const envToml = `{ ${Object.entries(entry.env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`;
  return [
    '-c', `${prefix}.command=${toml(entry.command)}`,
    '-c', `${prefix}.args=${argsToml}`,
    '-c', `${prefix}.env=${envToml}`,
  ];
}

/** Build the forgeax context string (game charter + active-game scope note +
 *  persona). app-server passes it as thread `developerInstructions`; the exec
 *  fallback prepends it to the first user message. */
async function buildForgeaxContext(req: ChatRequest, scopeSlug?: string): Promise<string> {
  const note = buildActiveGameNote(scopeSlug);
  let ctx = note ? `${FORGEAX_SYSTEM_PROMPT}\n\n${note}` : FORGEAX_SYSTEM_PROMPT;
  try {
    const personaId = req.agentId?.trim();
    if (personaId && personaId !== 'default' && personaId !== 'root') {
      const composed = await composeSystemPrompt(personaId);
      if (composed && composed.text.trim()) {
        ctx = `${ctx}\n\n---\n\n## Persona\n\n${composed.text.trim()}`;
      }
    }
  } catch (e) {
    console.warn(`[codex] persona compose failed for ${req.agentId}: ${(e as Error).message}`);
  }
  return ctx;
}

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  subAgents: false,
  sessions: false,
  jsonlReplay: false,
};

const DEFAULT_BINARY = 'codex';

/** Thrown by the app-server path when the server can't be started, so runChat
 *  can fall back to the legacy exec path without double-running. */
class AppServerUnavailable extends Error {}

/** Minimal push/pull async queue bridging the app-server client's callbacks to
 *  runChat's async-generator consumer. */
class EventQueue {
  private items: ChatEvent[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  push(ev: ChatEvent): void {
    this.items.push(ev);
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  end(): void {
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((res) => { this.waiter = res; });
    }
  }
}

export class CodexProvider implements CliProvider {
  readonly id = 'codex' as const;
  readonly displayName = 'OpenAI Codex';
  readonly capabilities = CAPABILITIES;

  private binary = DEFAULT_BINARY;
  private envOverride: Record<string, string> = {};

  /** chat-tab threadId → codex's own threadId (for thread/resume across turns;
   *  the exec fallback reuses the same map for `exec resume`). In-memory only. */
  private threadToCodex = new Map<string, string>();
  private readonly tracker = createCallTracker();

  async cancel(callId: string): Promise<void> {
    await this.tracker.cancel(callId);
  }

  async init(cfg: ProviderConfig): Promise<void> {
    const configuredBin = (cfg.options?.binary as string | undefined) ?? undefined;
    this.binary = await resolveBinary({
      configured: configuredBin,
      envVarName: 'CODEX_CLI_PATH',
      defaultBinary: DEFAULT_BINARY,
    });
    if (cfg.env) this.envOverride = cfg.env;
  }

  async shutdown(): Promise<void> {
    // app-server clients are per-turn; nothing long-lived to tear down.
  }

  private resolveCredentials(): { apiKey: string; baseUrl: string } {
    let apiKey = this.envOverride.OPENAI_API_KEY ?? '';
    let baseUrl = this.envOverride.OPENAI_BASE_URL ?? '';
    if (!apiKey || !baseUrl) {
      try {
        const route = resolveRoute('codex');
        if (route) {
          if (!apiKey && route.key) apiKey = route.key;
          if (!baseUrl && route.base_url) baseUrl = route.base_url;
        }
      } catch { /* keys.yaml missing → env */ }
    }
    if (!apiKey) apiKey = process.env.OPENAI_API_KEY ?? '';
    if (!baseUrl) baseUrl = process.env.OPENAI_BASE_URL ?? '';
    return { apiKey, baseUrl };
  }

  async health(timeoutMs = 1500): Promise<ProviderHealth> {
    const { apiKey } = this.resolveCredentials();
    const friendlyBin = friendlyPath(this.binary);
    let binaryOk = false;
    let binaryDetail: string | null = null;
    try {
      const proc = Bun.spawn({ cmd: [this.binary, '--version'], stdout: 'pipe', stderr: 'pipe' });
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      clearTimeout(t);
      const firstLine = out.split('\n', 1)[0]?.trim() ?? out;
      if (code === 0 && firstLine) { binaryOk = true; binaryDetail = `${friendlyBin} → ${firstLine}`; }
      else if (code === 0) binaryDetail = `${friendlyBin} ran but printed no --version output`;
      else binaryDetail = `binary ${friendlyBin} exited ${code}`;
    } catch (e) {
      const msg = (e as Error).message;
      binaryDetail = /ENOENT|not found/i.test(msg)
        ? `codex binary not on PATH (try: npm i -g @openai/codex)`
        : `cannot exec ${friendlyBin}: ${msg}`;
    }
    const missing: string[] = [];
    if (!binaryOk) missing.push(binaryDetail!);
    if (!apiKey) missing.push('OPENAI_API_KEY not set (or run `codex login`)');
    if (missing.length === 0) return { ok: true, detail: binaryDetail ?? undefined };
    if (binaryOk) return { ok: true, detail: missing.join(' · ') };
    return { ok: false, detail: missing.join(' · ') };
  }

  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return withCallLifecycle(req, signal, this.tracker, (h) => this.runChat(req, h.signal));
  }

  private async *runChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const h = await this.health(1000);
    if (!h.ok) {
      yield { type: 'error', message: h.detail ?? 'codex provider unhealthy', providerId: this.id };
      return;
    }
    try {
      yield* this.runChatAppServer(req, signal);
    } catch (e) {
      if (e instanceof AppServerUnavailable) {
        console.warn(`[codex] app-server unavailable, falling back to exec (no approval): ${e.message}`);
        yield* this.runChatExec(req, signal);
      } else {
        throw e;
      }
    }
  }

  // ─── PRIMARY: app-server with approval loop + incremental streaming ────────
  private async *runChatAppServer(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const projectRoot = defaultProjectRoot();
    const { apiKey, baseUrl } = this.resolveCredentials();
    const env: Record<string, string> = {};
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;

    const permSid = req.threadId?.trim() || req.sessionId?.trim() || '';
    const agent = req.agentId?.trim() || 'forge';

    const queue = new EventQueue();
    const outputByItem = new Map<string, string>();
    let lastUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;

    const mapNotification = (method: string, params: any): void => {
      switch (method) {
        case 'item/agentMessage/delta':
          if (typeof params?.delta === 'string' && params.delta) queue.push({ type: 'token', text: params.delta });
          return;
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
          if (typeof params?.delta === 'string' && params.delta) queue.push({ type: 'thinking', text: params.delta });
          return;
        case 'item/commandExecution/outputDelta': {
          const id = params?.itemId;
          const chunk = typeof params?.delta === 'string' ? params.delta : (typeof params?.chunk === 'string' ? params.chunk : '');
          if (id && chunk) outputByItem.set(id, (outputByItem.get(id) ?? '') + chunk);
          return;
        }
        case 'item/started': {
          const it = params?.item;
          if (!it?.id) return;
          if (it.type === 'commandExecution') queue.push({ type: 'tool-call', name: 'Bash', args: { command: it.command, cwd: it.cwd }, callId: it.id });
          else if (it.type === 'fileChange') queue.push({ type: 'tool-call', name: 'Edit', args: { changes: it.changes ?? it.fileChanges ?? null }, callId: it.id });
          else if (it.type === 'mcpToolCall') queue.push({ type: 'tool-call', name: it.tool ?? it.name ?? 'mcp', args: it.arguments ?? {}, callId: it.id });
          return;
        }
        case 'item/completed': {
          const it = params?.item;
          if (!it?.id) return;
          if (it.type === 'commandExecution' || it.type === 'fileChange' || it.type === 'mcpToolCall') {
            const ok = it.status === 'completed' || it.status === 'succeeded';
            const out = outputByItem.get(it.id) ?? (typeof it.aggregatedOutput === 'string' ? it.aggregatedOutput : '');
            outputByItem.delete(it.id);
            queue.push(ok
              ? { type: 'tool-result', callId: it.id, ok: true, result: out }
              : { type: 'tool-result', callId: it.id, ok: false, error: it.status ? `${it.status}${out ? ': ' + out : ''}` : (out || 'failed') });
          }
          // agentMessage/reasoning text already streamed via deltas → ignore.
          return;
        }
        case 'thread/tokenUsage/updated': {
          const t = params?.tokenUsage?.total;
          if (t) lastUsage = { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cachedInputTokens };
          return;
        }
        case 'turn/completed':
          queue.push({ type: 'done', stopReason: 'end_turn', ...(lastUsage ? { usage: lastUsage } : {}) });
          queue.end();
          return;
        case 'error':
          queue.push({ type: 'error', message: String(params?.message ?? 'codex error') });
          queue.end();
          return;
        case 'warning':
          if (params?.message) console.warn(`[codex] ${params.message}`);
          return;
        default:
          return; // tolerate unknown notifications (experimental proto)
      }
    };

    const handleServerRequest = async (rpc: ServerRequest): Promise<unknown> => {
      const m = rpc.method;
      const p = (rpc.params ?? {}) as any;
      const isExec = m === 'item/commandExecution/requestApproval' || m === 'execCommandApproval';
      const isPatch = m === 'item/fileChange/requestApproval' || m === 'applyPatchApproval';
      if (!isExec && !isPatch) {
        // Other server-requests (permissions/elicitation/tool-input) aren't
        // wired yet — reply with an error so codex doesn't hang on us.
        throw new Error(`unhandled codex server-request: ${m}`);
      }
      const toolName = isExec ? 'Bash' : 'Edit';
      const command = isExec
        ? (typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? p.command.join(' ') : (p.reason ?? 'run command'))
        : (p.reason ?? 'apply file changes');
      const { allow } = await awaitPermissionDecision({ sid: permSid, agent, toolName, command, input: p });
      // v1 methods use ReviewDecision (approved/denied); v2 use accept/decline.
      const v1 = m === 'execCommandApproval' || m === 'applyPatchApproval';
      if (v1) return { decision: allow ? 'approved' : 'denied' };
      return { decision: allow ? 'accept' : 'decline' };
    };

    const client = new CodexAppServerClient({
      binary: this.binary,
      cwd: projectRoot,
      env,
      globalArgs: forgeaxMcpConfigArgs(agent),
      onNotification: mapNotification,
      onServerRequest: handleServerRequest,
      onExit: (code, tail) => {
        queue.push({ type: 'error', message: `codex app-server exited ${code}${tail ? ': ' + tail : ''}` });
        queue.end();
      },
    });

    const onAbort = () => {
      queue.push({ type: 'done', stopReason: 'cancelled', code: 'cancelled' });
      queue.end();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    // Start the app-server. Failure here → fall back to exec (throw sentinel
    // BEFORE yielding anything).
    try {
      await client.ensureStarted();
    } catch (e) {
      signal.removeEventListener('abort', onAbort);
      client.shutdown();
      throw new AppServerUnavailable((e as Error).message);
    }

    try {
      // Ensure a codex thread for this chat tab (resume if we've seen it).
      let codexThreadId = permSid ? this.threadToCodex.get(permSid) : undefined;
      const startFresh = async (): Promise<string | undefined> => {
        const scopeSlug = sessionDefaultDir(req.sessionId ?? req.threadId) ?? getActiveGame(projectRoot);
        const developerInstructions = await buildForgeaxContext(req, scopeSlug);
        // IMPORTANT: do NOT use req.options.model here. The chat bridge resolves
        // the per-agent ModelPicker choice (agent.json::models.model) into
        // req.options.model for EVERY provider — but that picker's catalog is
        // Claude/forgeax model ids (e.g. "opus-4-7"). Codex's app-server accepts
        // such an unknown model on thread/start, then the turn produces ZERO
        // output and never completes (silent hang = "正在思考" forever). The UI
        // model picker is disabled for codex anyway; codex uses its own config
        // default unless CODEX_MODEL explicitly overrides. (verified 2026-06-16)
        const model = process.env.CODEX_MODEL?.trim() || undefined;
        const res = await client.request('thread/start', {
          cwd: projectRoot,
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          ...(developerInstructions ? { developerInstructions } : {}),
          ...(model ? { model } : {}),
          ephemeral: false,
        });
        return res?.thread?.id;
      };

      if (codexThreadId) {
        try {
          await client.request('thread/resume', { threadId: codexThreadId });
        } catch {
          codexThreadId = await startFresh();
        }
      } else {
        codexThreadId = await startFresh();
      }
      if (codexThreadId && permSid) this.threadToCodex.set(permSid, codexThreadId);
      if (!codexThreadId) {
        yield { type: 'error', message: 'codex thread/start returned no id', providerId: this.id };
        return;
      }

      await client.request('turn/start', {
        threadId: codexThreadId,
        input: [{ type: 'text', text: req.message, text_elements: [] }],
      });

      for await (const ev of queue) {
        (ev as ChatEvent).providerId = this.id;
        yield ev;
        if (ev.type === 'done' || ev.type === 'error') break;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.shutdown();
    }
  }

  // ─── FALLBACK: legacy one-shot `codex exec --json` (no approval) ───────────
  private async *runChatExec(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const { apiKey, baseUrl } = this.resolveCredentials();
    const env: Record<string, string> = {};
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;

    const projectRoot = defaultProjectRoot();
    const tid = req.threadId?.trim();
    const codexId = tid ? this.threadToCodex.get(tid) : undefined;
    const isFirstTurn = !codexId;

    let finalPrompt = req.message;
    if (isFirstTurn) {
      const scopeSlug = sessionDefaultDir(req.sessionId ?? req.threadId) ?? getActiveGame(projectRoot);
      const ctx = await buildForgeaxContext(req, scopeSlug);
      finalPrompt = `${ctx}\n\n---\n\n${req.message}`;
    }

    // See runChatAppServer: req.options.model carries a Claude-catalog id that
    // hangs codex. Only honor CODEX_MODEL; otherwise codex uses its config default.
    const selectedModel = process.env.CODEX_MODEL?.trim() || '';

    const args = [
      ...forgeaxMcpConfigArgs(req.agentId?.trim() || 'forge'),
      'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check',
      ...(selectedModel ? ['-m', selectedModel] : []),
      ...(codexId ? ['resume', codexId] : []),
      finalPrompt,
    ];

    const { lines, exit } = spawnJsonl<CodexRawEvent>({ cmd: this.binary, args, env, cwd: projectRoot, signal });
    const state = createCodexMapperState();
    try {
      for await (const raw of lines) {
        if (tid && !this.threadToCodex.has(tid) && (raw as { type?: string }).type === 'thread.started') {
          const id = (raw as { thread_id?: string }).thread_id;
          if (typeof id === 'string' && id.length > 0) this.threadToCodex.set(tid, id);
        }
        for (const ev of mapCodexEvent(raw, state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } catch (streamErr) {
      yield { type: 'error', message: `codex stream error: ${(streamErr as Error).message}`, providerId: this.id };
    }

    const exitInfo = await exit;
    if (!state.doneEmitted) {
      if (exitInfo.code !== 0) {
        const stderrTail = exitInfo.stderr.split('\n').slice(-3).join(' | ').trim();
        const detail = state.lastError || stderrTail;
        yield { type: 'error', message: `codex exited ${exitInfo.code}${detail ? ': ' + detail : ''}`, providerId: this.id };
      } else {
        for (const ev of flushCodexMapper(state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } else if (exitInfo.stderr.trim()) {
      const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
      console.warn(`[codex] stderr (exit ${exitInfo.code}, done already emitted): ${tail}`);
    }
  }
}
