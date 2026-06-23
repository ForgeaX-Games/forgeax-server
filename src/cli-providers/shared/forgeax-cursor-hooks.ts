// forgeax-managed cursor-agent hooks config, written to <workspace>/.cursor/
// hooks.json per turn (see providers/cursor-agent.ts). This is how forgeax makes
// "dangerous operations pop the approval card" deterministic for cursor-agent —
// the exact analogue of forgeax-claude-settings.ts for the claude-code provider.
//
// ── Why this shape (empirically verified 2026-06-16, cursor-agent 2026.06.15) ──
// cursor-agent headless has only two built-in modes: default (auto-REJECTS every
// approval-requiring shell/write — useless, the agent can't build) or `--force`
// (allow-all, fail-open, no card). Its ONLY per-command approval injection point
// is Hooks: a `beforeShellExecution`/`beforeMCPExecution` hook returning
// {permission:"allow"|"deny"} runs in headless mode (verified) and its verdict is
// honored. So we run with `--force` (smooth in-workspace baseline, ≈ claude-code
// acceptEdits) and layer a `matcher`-scoped blocking hook (≈ permissions.ask):
// only the dangerous list reaches the hook → the Studio card; everything else is
// allowed by --force without a prompt.
//
// cursor has no `--hooks <path>` flag (claude-code keys its --mcp-config file by
// sid), so hooks.json must live at <workspace>/.cursor/hooks.json and its CONTENT
// must be static across turns — the per-turn sid travels on the hook's stdin
// `session_id` instead (cursor-permission-hook.mjs → /api/cli/cursor-permission
// maps it back). `matcher` is a regex tested against the command string
// (verified: matcher "echo" fired for `echo …`).

/** The forgeax "dangerous ops" matcher for cursor-agent. Union of the claude-code
 *  provider's `ask` + `deny` lists (forgeax-claude-settings.ts) as a single
 *  regex: commands matching this invoke the approval hook; the hook itself
 *  hard-denies the catastrophic subset (CATASTROPHIC in cursor-permission-hook.mjs)
 *  and routes the rest to the Studio card. Non-matching commands run under
 *  --force without a prompt. */
export const CURSOR_DANGER_MATCHER = [
  // Destructive file ops + privilege escalation + process control + net egress
  '\\b(rm|rmdir|sudo|doas|chmod|chown|curl|wget|ssh|scp|nc|kill|pkill|killall)\\b',
  // History-rewriting / outbound git
  'git\\s+push',
  'git\\s+reset\\s+--hard',
  'git\\s+clean',
  // Publishing / releasing
  '(npm|pnpm|yarn)\\s+publish',
  // Catastrophic (also hard-denied inside the hook, but must match to fire it)
  '\\b(dd|mkfs\\w*|shred)\\b',
].join('|');

export interface CursorHookEntry {
  command: string;
  matcher?: string;
}

export interface CursorHooksConfig {
  version: number;
  hooks: Record<string, CursorHookEntry[]>;
}

export interface BuildCursorHooksOptions {
  /** Absolute path to cursor-permission-hook.mjs. */
  hookScriptPath: string;
  /** Node/bun executable to run the hook with (process.execPath). */
  nodeBin: string;
  /** forgeax server port the hook posts back to (the hook builds the URL). */
  serverPort: string;
}

/** Build the .cursor/hooks.json object.
 *
 *  ⚠️ cursor runs the hook `command` WITHOUT a shell (verified live 2026-06-16):
 *  a `VAR=val cmd` env-prefix is NOT honored (exec fails → cursor fails OPEN →
 *  the command runs with no card), and an argument containing `://` (a full URL)
 *  ALSO breaks command parsing the same way. So we pass NEITHER: the server
 *  PORT is the only argument (bare, no scheme), and the hook builds the URL
 *  itself. Double-quoting the two paths is safe (handles spaces) and was
 *  verified to still fire. Shell commands are matcher-scoped to the danger list;
 *  MCP tool calls are gated unconditionally (rare in game-dev, conservative). */
export function buildCursorHooksConfig(opts: BuildCursorHooksOptions): CursorHooksConfig {
  const cmd = `${JSON.stringify(opts.nodeBin)} ${JSON.stringify(opts.hookScriptPath)} ${opts.serverPort}`;
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: cmd, matcher: CURSOR_DANGER_MATCHER }],
      beforeMCPExecution: [{ command: cmd }],
    },
  };
}
