/** permission-registry —— 命令审批的「阻塞 + HTTP 回执」往返中枢。
 *
 *  背景:非交互式 spawn 下,需要用户审批的命令若没有应答者会被自动拒绝。修法是给
 *  spawn 配 permission-prompt 工具:CLI 要权限时调一个 forgeax 提供的 MCP 工具,
 *  该工具 HTTP 回打到 server 的 /:sid/permission-request,由本 registry 注册一个
 *  阻塞 Promise + 经 EventBus 弹审批卡给前端;用户点「允许/拒绝」后 POST
 *  /:sid/permission-reply 解开它,决定回灌给 MCP 工具 → 命令执行或拦下。
 *
 *  模块级 Map(单进程 Bun 安全),键用 **reqId**(随机 UUID)而非 sid::agentPath
 *  —— 一次 turn 内可能连续请求多个命令的权限,reqId 天然唯一、互不顶替。 */

import { randomUUID } from 'node:crypto';
import { getSessionManager } from './session-manager';

interface Pending {
  resolve: (allow: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Owner of this request, so a turn that aborts/ends can release every
   *  permission it was blocking. `sid` is the thread/session id the MCP
   *  permission-server posted to (== FORGEAX_SID); `agent` is its FORGEAX_AGENT
   *  attribution. Matched in denyPermissionsForSession(). */
  sid: string;
  agent: string;
}

const pending = new Map<string, Pending>();

/** Owner of a permission request — who to attribute it to so a finished turn
 *  can find and release the ones it was blocking. */
export interface PermissionOwner {
  sid: string;
  agent: string;
}

export interface PermissionHandle {
  /** Resolves to true (allow) / false (deny). Times out → false (deny). */
  promise: Promise<boolean>;
  /** Idempotent cleanup — drops the entry + clears the timer. Call in finally
   *  AFTER the promise settled. */
  dispose(): void;
}

/** Register a pending permission request. Resolves when the UI replies via
 *  resolvePermission(reqId, …) or to `false` (deny) on timeout — a request no
 *  one answers must fail closed, never silently allow. */
export function registerPermission(
  reqId: string,
  timeoutMs: number,
  owner: PermissionOwner,
): PermissionHandle {
  // Defensive: drop any stale entry under the same reqId (shouldn't happen with
  // random UUIDs, but keep the map clean).
  const prev = pending.get(reqId);
  if (prev) {
    clearTimeout(prev.timer);
    prev.resolve(false);
    pending.delete(reqId);
  }

  let settle!: (allow: boolean) => void;
  const promise = new Promise<boolean>((res) => { settle = res; });

  const timer = setTimeout(() => {
    if (pending.get(reqId)?.resolve === settle) pending.delete(reqId);
    settle(false); // fail closed on timeout
  }, timeoutMs);

  pending.set(reqId, { resolve: settle, timer, sid: owner.sid, agent: owner.agent });

  return {
    promise,
    dispose() {
      const cur = pending.get(reqId);
      if (cur && cur.resolve === settle) {
        clearTimeout(cur.timer);
        pending.delete(reqId);
      }
    },
  };
}

/** Resolve a pending permission with the user's decision. Returns true when a
 *  matching pending entry was found (and resolved), false otherwise
 *  (already answered / timed out / unknown reqId). */
export function resolvePermission(reqId: string, allow: boolean): boolean {
  const entry = pending.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(reqId);
  entry.resolve(allow);
  return true;
}

/** Release (deny + drop) every pending permission owned by `sid`, optionally
 *  narrowed to one `agent`. Called when a turn aborts/ends/errors: a blocked
 *  /permission-request belongs to that turn, so once the turn is dead its held
 *  HTTP call must fail closed *immediately* instead of hanging to the 10-min
 *  timeout against a turn whose subprocess is already gone. Each
 *  resolved request's /permission-request finally then publishes
 *  `permission:resolved`, which dismisses the lingering card in the UI.
 *
 *  Fails closed (deny), never allow — a turn we can no longer drive must not
 *  retroactively approve a command. Returns the reqIds that were released. */
export function denyPermissionsForSession(sid: string, agent?: string): string[] {
  const hits: string[] = [];
  for (const [reqId, entry] of pending) {
    if (entry.sid !== sid) continue;
    if (agent && entry.agent !== agent) continue;
    hits.push(reqId);
  }
  for (const reqId of hits) resolvePermission(reqId, false);
  return hits;
}

// NOTE: pending entries are in-memory only; a server restart drops any
// in-flight permission requests (their held /permission-request HTTP calls
// then time out fail-closed = deny on the MCP side). That's the intended,
// safe behavior — a restart must never leave a command auto-approved.

// ─── Shared approval-card flow (provider-agnostic) ──────────────────────────
// The "pop a card on the session EventBus, block until the UI replies" round
// trip used to live inline in api/sessions.ts's /permission-request route.
// Extracted here so BOTH surfaces reuse one implementation:
//   1. claude-code: its MCP permission-server.mjs HTTP-POSTs /permission-request,
//      whose route now just calls awaitPermissionDecision().
//   2. codex: the in-process app-server client (cli-providers/shared/
//      codex-appserver-client.ts) calls awaitPermissionDecision() DIRECTLY on
//      an exec/patch approval ServerRequest — no self-HTTP.
// The Studio approval card (interface PermissionPrompt) + /permission-reply are
// unchanged: they're keyed on reqId and don't care which provider asked.

/** Default block window before a permission request fails closed (deny). */
export const PERMISSION_TIMEOUT_MS = 10 * 60_000;

// AskUserQuestion answer side-channel: /permission-reply stashes the user's
// chosen answers (keyed by reqId) here; awaitPermissionDecision reads+clears
// them after the await so the caller (MCP) can inject updatedInput.answers.
const permissionAnswers = new Map<string, Record<string, string>>();

/** Called by /permission-reply when the user's reply carries `answers`
 *  (AskUserQuestion). Stash before resolving so awaitPermissionDecision can
 *  return them. */
export function stashPermissionAnswers(reqId: string, answers: Record<string, string>): void {
  if (reqId && answers && Object.keys(answers).length > 0) permissionAnswers.set(reqId, answers);
}

export interface PermissionRequestInput {
  /** Session/thread id the UI is watching (== FORGEAX_SID for claude-code). */
  sid: string;
  /** Agent attribution for the card + ownership (denyPermissionsForSession). */
  agent?: string;
  /** Tool name shown on the card (e.g. 'Bash', 'Write', 'AskUserQuestion'). */
  toolName: string;
  /** Human-readable one-liner (command text / file path). */
  command: string;
  /** Raw tool input echoed to the card for richer rendering. */
  input?: unknown;
  /** Override the fail-closed timeout. */
  timeoutMs?: number;
}

/** Pop the Studio approval card for `sid` and block until the user replies
 *  (allow/deny) or it times out (fail closed = deny). Provider-agnostic: any
 *  in-process caller can use it; claude-code reaches it via the
 *  /permission-request route, codex calls it directly. Returns `allow` plus any
 *  AskUserQuestion `answers` the reply carried. If the session can't be found,
 *  denies immediately (no card). */
export async function awaitPermissionDecision(
  opts: PermissionRequestInput,
): Promise<{ allow: boolean; answers?: Record<string, string> }> {
  const agent = opts.agent?.trim() || 'forge';
  const session = getSessionManager().peek(opts.sid);
  if (!session) return { allow: false };

  const reqId = randomUUID();
  session.eventBus.publish(
    {
      type: 'permission:request',
      ts: Date.now(),
      source: `agent:${agent}`,
      payload: { reqId, toolName: opts.toolName, command: opts.command, input: opts.input ?? null, agent },
    },
    agent,
  );

  const handle = registerPermission(reqId, opts.timeoutMs ?? PERMISSION_TIMEOUT_MS, { sid: opts.sid, agent });
  let allow = false;
  try {
    allow = await handle.promise;
  } finally {
    handle.dispose();
    session.eventBus.publish(
      {
        type: 'permission:resolved',
        ts: Date.now(),
        source: `agent:${agent}`,
        payload: { reqId, allow },
      },
      agent,
    );
  }
  const answers = permissionAnswers.get(reqId);
  permissionAnswers.delete(reqId);
  return { allow, ...(answers ? { answers } : {}) };
}
