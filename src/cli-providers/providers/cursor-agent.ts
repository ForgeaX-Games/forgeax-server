// CursorAgentProvider — spawns Cursor's `cursor-agent` CLI per chat turn,
// translates its stream-json ndjson into ChatEvent, and surfaces it through the
// CliProvider interface. Sibling of providers/claude-code.ts.
//
// The binary is `cursor-agent`. Resolution: ProviderConfig.options.binary →
// CURSOR_CLI_PATH env → `which cursor-agent` → literal "cursor-agent".
//
// ── Permission model (empirically verified 2026-06-16, cursor-agent 2026.06.15) ──
// cursor-agent headless has no permission-prompt-tool (claude-code) nor an
// app-server approval channel (codex). Its ONLY per-command approval injection
// point is Hooks. So we run with `--force` (smooth in-workspace baseline, the
// acceptEdits analogue) and write a matcher-scoped blocking hook to
// <workspace>/.cursor/hooks.json (see shared/forgeax-cursor-hooks.ts): dangerous
// commands invoke cursor-permission-hook.mjs → POST /api/cli/cursor-permission →
// the SAME Studio approval card the other providers use. cursor's hooks.json
// can't be keyed per-turn (no --hooks flag), so its content is static and the
// per-turn sid is mapped from cursor's chat id via cursorSessionToForgeax below,
// pre-registered before spawn (so a hook can never race ahead of the mapping).
//
// Per-turn lifecycle (chat()):
//   1. ensure a cursor chat id for the thread (`create-chat` first turn; reuse +
//      `--resume <id>` after) — registered in cursorSessionToForgeax up front
//   2. write <projectRoot>/.cursor/hooks.json (static forgeax danger gating)
//   3. spawn `cursor-agent -p --output-format stream-json --stream-partial-output
//      --trust --force [--model] --resume <id> <message>`
//   4. drain stdout ndjson through cursor-mapper
//   5. on AbortSignal: SIGTERM → SIGKILL (spawnJsonl)

import type {
  CliProvider,
  ChatEvent,
  ChatRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderHealth,
} from '../types';
import { spawnJsonl } from '../shared/subprocess-jsonl';
import { friendlyPath } from '../../api/lib/friendly-path';
import { resolveBinary } from '../shared/resolve-binary';
import { defaultProjectRoot } from '../../api/lib/safe-path';
import { getActiveGame } from '../../api/lib/active-game';
import { sessionDefaultDir } from '../shared/scope-slug';
import { resolveRoute } from '../key-registry';
import { composeSystemPrompt } from '../../agents/loader';
import { buildGameCharter, buildActiveGameNote } from '../../agents/game-charter';
import { createCallTracker, withCallLifecycle } from '../shared/call-lifecycle';
import {
  createCursorMapperState,
  flushCursorMapper,
  mapCursorEvent,
  type CursorRawEvent,
} from '../shared/cursor-mapper';
import { buildCursorHooksConfig } from '../shared/forgeax-cursor-hooks';
import { forgeaxToolsServerEntry, ensureCursorMcpServer } from '../shared/forgeax-tools-mcp';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';
const INTERFACE_PORT = process.env.FORGEAX_INTERFACE_PORT ?? '18920';

const FORGEAX_SYSTEM_PROMPT = buildGameCharter({
  serverPort: SERVER_PORT,
  interfacePort: INTERFACE_PORT,
});

// ── cursor chat id → forgeax permission context ─────────────────────────────
// cursor-permission-hook.mjs posts cursor's session_id; the /api/cli/
// cursor-permission route looks it up here to find the forgeax thread/session
// the Studio card belongs to. Module-level (single Bun process), pre-registered
// before spawn and released on turn end.
const cursorSessionToForgeax = new Map<string, { sid: string; agent: string }>();

/** Resolve cursor's chat id → the forgeax {sid, agent} for the approval card.
 *  Consumed by api/cli/chat.ts's /cursor-permission route. */
export function lookupCursorSession(cursorSessionId: string): { sid: string; agent: string } | undefined {
  return cursorSessionToForgeax.get(cursorSessionId);
}

// cursor-agent headless (`-p`) has NO interactive-question channel: its built-in
// `askQuestion` tool is auto-skipped (`result.rejected: "Questions skipped by
// user"`) and — unlike claude-code's AskUserQuestion, which forgeax answers via
// the permission-prompt MCP — it fires NO hook, so the picked answer can never be
// routed back into the running turn (verified 2026-06-16, cursor 2026.06.15).
// Steer cursor to ask in plain text instead, so the flow isn't a dead end. This
// is cursor-ONLY (appended here, not in the shared game charter) — claude-code's
// option card still works and must stay.
const CURSOR_ASK_NOTE = [
  '## 交互限制(重要)',
  '当前运行环境下你**没有可用的交互式选择工具**:`askQuestion` / `AskQuestion`',
  '工具会被自动跳过,你拿不到用户的选择。需要用户做选择、确认或回答问题时,**不要',
  '调用 ask/askQuestion 工具** —— 直接用普通中文把问题和选项列清楚(例如「你想要 A',
  '还是 B?」),然后停下来等用户在下一条消息里回答。',
].join('\n');

/** Build the forgeax context (game charter + active-game note + persona).
 *  cursor-agent has no --append-system-prompt, so this is prepended to the user
 *  message on the FIRST turn of a chat (subsequent turns inherit it via resume). */
async function buildForgeaxContext(req: ChatRequest, scopeSlug?: string): Promise<string> {
  const note = buildActiveGameNote(scopeSlug);
  let ctx = note ? `${FORGEAX_SYSTEM_PROMPT}\n\n${note}` : FORGEAX_SYSTEM_PROMPT;
  ctx = `${ctx}\n\n${CURSOR_ASK_NOTE}`;
  try {
    const personaId = req.agentId?.trim();
    if (personaId && personaId !== 'default' && personaId !== 'root') {
      const composed = await composeSystemPrompt(personaId);
      if (composed && composed.text.trim()) {
        ctx = `${ctx}\n\n---\n\n## Persona\n\n${composed.text.trim()}`;
      }
    }
  } catch (e) {
    console.warn(`[cursor-agent] persona compose failed for ${req.agentId}: ${(e as Error).message}`);
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

const DEFAULT_BINARY = 'cursor-agent';

export class CursorAgentProvider implements CliProvider {
  readonly id = 'cursor-agent' as const;
  readonly displayName = 'Cursor';
  readonly capabilities = CAPABILITIES;

  private binary = DEFAULT_BINARY;
  private envOverride: Record<string, string> = {};

  /** chat-tab threadId → cursor's chat id (for `--resume` across turns). */
  private threadToCursor = new Map<string, string>();
  private readonly tracker = createCallTracker();

  async cancel(callId: string): Promise<void> {
    await this.tracker.cancel(callId);
  }

  async init(cfg: ProviderConfig): Promise<void> {
    const configuredBin = (cfg.options?.binary as string | undefined) ?? undefined;
    this.binary = await resolveBinary({
      configured: configuredBin,
      envVarName: 'CURSOR_CLI_PATH',
      defaultBinary: DEFAULT_BINARY,
    });
    if (cfg.env) this.envOverride = cfg.env;
  }

  async shutdown(): Promise<void> {
    // No long-lived state — each chat() spawns a fresh subprocess.
  }

  private resolveApiKey(): string {
    let apiKey = this.envOverride.CURSOR_API_KEY ?? '';
    if (!apiKey) {
      try {
        const route = resolveRoute('cursor');
        if (route?.key) apiKey = route.key;
      } catch { /* keys.yaml missing → env / login */ }
    }
    if (!apiKey) apiKey = process.env.CURSOR_API_KEY ?? '';
    return apiKey;
  }

  async health(timeoutMs = 1500): Promise<ProviderHealth> {
    const apiKey = this.resolveApiKey();
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
        ? `cursor-agent binary not on PATH (install: https://cursor.com/cli)`
        : `cannot exec ${friendlyBin}: ${msg}`;
    }
    // cursor-agent supports `login` (no API key needed), so a missing
    // CURSOR_API_KEY is NOT fatal — only the binary is required. Surface the
    // key/login hint as detail but keep ok=true when the binary works (codex
    // does the same for its login flow).
    const missing: string[] = [];
    if (!binaryOk) missing.push(binaryDetail!);
    if (!apiKey) missing.push('CURSOR_API_KEY not set (or run `cursor-agent login`)');
    if (missing.length === 0) return { ok: true, detail: binaryDetail ?? undefined };
    if (binaryOk) return { ok: true, detail: missing.join(' · ') };
    return { ok: false, detail: missing.join(' · ') };
  }

  /** Run `cursor-agent create-chat` and return the new chat id (a UUID on its
   *  own line). Returns undefined on failure so the caller falls back to a
   *  session-less turn. */
  private async createChat(env: Record<string, string>, cwd: string): Promise<string | undefined> {
    try {
      const proc = Bun.spawn({
        cmd: [this.binary, 'create-chat'],
        cwd,
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 15_000);
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      clearTimeout(t);
      if (code !== 0) return undefined;
      const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return m?.[0];
    } catch {
      return undefined;
    }
  }

  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return withCallLifecycle(req, signal, this.tracker, (h) => this.runChat(req, h.signal));
  }

  private async *runChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const h = await this.health(1000);
    if (!h.ok) {
      yield { type: 'error', message: h.detail ?? 'cursor-agent provider unhealthy', providerId: this.id };
      return;
    }

    const env: Record<string, string> = {};
    const apiKey = this.resolveApiKey();
    if (apiKey) env.CURSOR_API_KEY = apiKey;

    const projectRoot = defaultProjectRoot();
    const permSid = req.threadId?.trim() || req.sessionId?.trim() || '';
    const agent = req.agentId?.trim() || 'forge';

    // Session continuity: ensure a cursor chat id for this thread. First turn →
    // `create-chat`; later turns reuse it. We pre-create (rather than parsing the
    // stream's system.init id) so the cursorSession→forgeax mapping is registered
    // BEFORE spawn — a permission hook can then never fire ahead of the mapping.
    const tid = req.threadId?.trim();
    let cursorChatId = tid ? this.threadToCursor.get(tid) : undefined;
    let isFirstTurn = false;
    if (!cursorChatId) {
      isFirstTurn = true;
      cursorChatId = await this.createChat(env, projectRoot);
      if (cursorChatId && tid) this.threadToCursor.set(tid, cursorChatId);
    }

    // Permission wiring: write the forgeax danger-gating hooks + register the
    // sid mapping. Both are gated on having a sid the UI is watching AND a
    // cursor chat id (the hook keys on it). Without them we fall back to the
    // raw `--force` baseline (in-workspace ops still run; the danger card just
    // can't be routed — same posture as claude-code skipping the prompt-tool).
    let releaseSession: (() => void) | null = null;
    if (permSid && cursorChatId) {
      try {
        const hookScriptPath = resolvePath(import.meta.dir, '../mcp/cursor-permission-hook.mjs');
        const cfg = buildCursorHooksConfig({
          hookScriptPath,
          nodeBin: process.execPath,
          serverPort: process.env.FORGEAX_SERVER_PORT ?? '18900',
        });
        mkdirSync(resolvePath(projectRoot, '.cursor'), { recursive: true });
        writeFileSync(resolvePath(projectRoot, '.cursor', 'hooks.json'), JSON.stringify(cfg, null, 2));
        cursorSessionToForgeax.set(cursorChatId, { sid: permSid, agent });
        releaseSession = () => cursorSessionToForgeax.delete(cursorChatId!);
      } catch (e) {
        console.warn(`[cursor-agent] permission hook wiring failed: ${(e as Error).message}`);
      }
    }

    // Host tools (wb-bgm audio library, …): cursor has no --mcp-config flag — it
    // reads <cwd>/.cursor/mcp.json — so merge our server in before spawn, then
    // `--approve-mcps` to trust it headlessly. Same entry claude-code registers.
    ensureCursorMcpServer(
      projectRoot,
      forgeaxToolsServerEntry(
        import.meta.dir,
        process.execPath,
        process.env.FORGEAX_SERVER_PORT ?? '18900',
        req.agentId?.trim() || 'forge',
      ),
    );

    // Model: cursor-agent accepts `--model`, but the Studio ModelPicker catalog
    // is Claude-shaped (opus-4-x), which cursor would reject. So — like codex —
    // ignore req.options.model and honor only an explicit CURSOR_MODEL env.
    const selectedModel = process.env.CURSOR_MODEL?.trim() || '';

    // First turn: prepend the forgeax charter/persona to the message (no
    // --append-system-prompt on cursor). Later turns inherit it via --resume.
    let message = req.message;
    if (isFirstTurn) {
      const scopeSlug = sessionDefaultDir(req.sessionId ?? req.threadId) ?? getActiveGame(projectRoot);
      const ctx = await buildForgeaxContext(req, scopeSlug);
      message = `${ctx}\n\n---\n\n${req.message}`;
    }

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      // Trust the workspace (headless requires it) + force-allow as the smooth
      // baseline; the danger hook (when wired) re-gates risky ops to the card.
      '--trust',
      '--force',
      // Auto-approve MCP servers from .cursor/mcp.json (incl. forgeax-tools) so
      // the headless run loads them without an interactive trust prompt.
      '--approve-mcps',
      ...(selectedModel ? ['--model', selectedModel] : []),
      ...(cursorChatId ? ['--resume', cursorChatId] : []),
      message,
    ];

    const traceTag = (req.threadId ?? req.sessionId ?? req.agentId ?? '?').slice(0, 8);
    const { lines, exit } = spawnJsonl<CursorRawEvent>({
      cmd: this.binary,
      args,
      env,
      cwd: projectRoot,
      signal,
    });

    const state = createCursorMapperState();
    const rawDumpEnv = process.env.FORGEAX_CURSOR_RAW_DUMP;
    const rawDumpPath = rawDumpEnv
      ? (rawDumpEnv === '1' ? '/tmp/forgeax-cursor-raw.ndjson' : rawDumpEnv)
      : undefined;

    try {
      for await (const raw of lines) {
        if (rawDumpPath) {
          try { appendFileSync(rawDumpPath, `${traceTag} ${JSON.stringify(raw)}\n`); } catch { /* best-effort */ }
        }
        for (const ev of mapCursorEvent(raw, state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } catch (streamErr) {
      yield { type: 'error', message: `cursor-agent stream error: ${(streamErr as Error).message}`, providerId: this.id };
    } finally {
      if (releaseSession) releaseSession();
    }

    const exitInfo = await exit;
    if (!state.doneEmitted) {
      if (exitInfo.code !== 0) {
        const stderrTail = exitInfo.stderr.split('\n').slice(-3).join(' | ').trim();
        yield { type: 'error', message: `cursor-agent exited ${exitInfo.code}${stderrTail ? ': ' + stderrTail : ''}`, providerId: this.id };
      } else {
        for (const ev of flushCursorMapper(state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } else if (exitInfo.stderr.trim()) {
      const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
      console.warn(`[cursor-agent] stderr (exit ${exitInfo.code}, done already emitted): ${tail}`);
    }
  }
}
