#!/usr/bin/env node
/** forgeax cursor-agent permission hook (stdin/stdout).
 *
 *  Wired into a cursor-agent spawn via `<workspace>/.cursor/hooks.json`'s
 *  `beforeShellExecution` / `beforeMCPExecution` entries (see
 *  shared/forgeax-cursor-hooks.ts). cursor-agent runs headless with `--force`
 *  (so in-workspace edits + plain commands run smoothly, the acceptEdits
 *  analogue); a `matcher` regex restricts THIS hook to the dangerous-ops list,
 *  so only risky commands reach us.
 *
 *  Contract (verified live, cursor-agent 2026.06.15):
 *    stdin  — one JSON object: { command, cwd, sandbox, session_id,
 *             conversation_id, tool_name?, tool_input?, url? , ... }
 *    stdout — one JSON object: { permission: "allow" | "deny", agent_message? }
 *             exit 0. (exit 2 also means deny; other non-zero fails open.)
 *
 *  We DON'T decide here. We HTTP-call back to the forgeax server, which maps
 *  cursor's session_id → the forgeax thread/session id the Studio UI is
 *  watching, pops the SAME approval card the claude-code/codex providers use,
 *  and blocks until the user clicks. cursor's hooks.json can't take a per-turn
 *  path (no `--hooks <file>` flag), so the file is STATIC and the sid travels
 *  on stdin's session_id — this is what keeps concurrent chat tabs correct.
 *
 *  Catastrophic, never-legit commands (dd/mkfs/rm -rf / …) are hard-denied here
 *  WITHOUT a card (mirrors claude-code's `permissions.deny`). Fails CLOSED: any
 *  transport error → deny.
 */

import { appendFileSync } from 'node:fs';

// Server origin. cursor runs this hook WITHOUT a shell and mangles any arg
// containing `://`, so the provider passes only the PORT as argv[2] (bare, no
// scheme) and we build the URL here. Env / default kept as fallbacks.
const PORT_ARG = (process.argv[2] || '').trim();
const SERVER_URL = (
  process.env.FORGEAX_SERVER_URL ||
  (PORT_ARG ? `http://127.0.0.1:${PORT_ARG}` : 'http://127.0.0.1:18900')
).replace(/\/$/, '');
const DEBUG = process.env.FORGEAX_CURSOR_HOOK_DEBUG;
const dbg = (m) => { if (DEBUG) { try { appendFileSync('/tmp/forgeax-cursor-hook.log', `${new Date().toISOString()} ${m}\n`); } catch {} } };

// Catastrophic ops: deny outright, no card. Only BARE root/home wipes —
// `rm -rf /`, `rm -rf /*`, `rm -rf ~` — i.e. the `/` or `~` is the WHOLE target
// (immediately followed by whitespace, a glob `*`, or end-of-string). A specific
// absolute path like `rm -rf /Users/you/proj/a.txt` is NOT catastrophic; it must
// route to the approval CARD (the user explicitly wants to confirm those), so it
// falls through to askForgeax below.
const CATASTROPHIC = /\b(dd|mkfs\w*|shred)\b|\brm\s+-rf\s+[/~](\s|\*|$)|\bsudo\s+rm\b/;

function emit(permission, agentMessage) {
  const out = { permission };
  if (agentMessage) out.agent_message = agentMessage;
  process.stdout.write(JSON.stringify(out) + '\n');
}

/** Ask the forgeax UI (blocks until the user answers or the server times out). */
async function askForgeax({ cursorSessionId, toolName, command, input }) {
  if (!cursorSessionId) { dbg('no cursor session_id → deny'); return false; }
  try {
    const res = await fetch(`${SERVER_URL}/api/cli/cursor-permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cursorSessionId, toolName, command, input }),
    });
    if (!res.ok) { dbg(`HTTP ${res.status} → deny`); return false; }
    const j = await res.json();
    dbg(`decision allow=${j?.allow}`);
    return j?.allow === true;
  } catch (e) {
    dbg(`error ${e?.message} → deny`);
    return false; // fail closed
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

(async () => {
  let payload = {};
  try { payload = JSON.parse((await readStdin()).trim() || '{}'); } catch { payload = {}; }

  const cursorSessionId = payload.session_id || payload.conversation_id || '';
  const event = payload.hook_event_name || '';
  // beforeShellExecution carries `command`; beforeMCPExecution carries
  // tool_name + tool_input (+ url/command). Normalize to a one-liner for the card.
  const toolName = event === 'beforeMCPExecution' ? (payload.tool_name || 'mcp') : 'Bash';
  const command =
    (typeof payload.command === 'string' && payload.command) ||
    (typeof payload.url === 'string' && payload.url) ||
    (payload.tool_input ? JSON.stringify(payload.tool_input).slice(0, 300) : '') ||
    toolName;
  const input = payload.tool_input ?? { command, cwd: payload.cwd };

  dbg(`hook ${event} sid=${cursorSessionId} cmd=${String(command).slice(0, 120)}`);

  if (typeof command === 'string' && CATASTROPHIC.test(command)) {
    dbg('catastrophic → hard deny (no card)');
    emit('deny', 'forgeax: 该命令被安全策略直接拒绝(灾难性操作)');
    return;
  }

  const allow = await askForgeax({ cursorSessionId, toolName, command, input });
  if (allow) emit('allow');
  else emit('deny', 'forgeax: 用户在 Studio 里拒绝了这个命令');
})();
