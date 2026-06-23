// forgeax-managed Claude Code settings, injected per chat turn via the CLI's
// `--settings <json>` flag (see providers/claude-code.ts). This is how forgeax
// makes "dangerous operations pop the approval card" deterministic and
// MACHINE-INDEPENDENT — instead of relying on whatever the operator happens to
// have in their personal ~/.claude/settings.json.
//
// ── Why this exists (root cause, empirically verified 2026-06-16) ──
// We spawn claude with `--permission-mode acceptEdits`, which auto-approves
// EVERYTHING inside the working directory (file edits AND in-cwd Bash). The
// `--permission-prompt-tool` (our approval card) is therefore only consulted
// for ops OUTSIDE the workspace or commands matching an `ask`/`deny` rule. Since
// Forge writes games into cwd-relative `.forgeax/games/<slug>/`, the card almost
// never fired ("审批不容易触发"). Claude Code's `permissions.ask` rules force a
// prompt REGARDLESS of permission-mode, and when a `--permission-prompt-tool` is
// wired that prompt becomes our card. So an injected `ask` list reliably gates
// the dangerous stuff while normal game-dev edits stay smooth.
//
// Matcher form: probed live (claude 2.1.175) — both `Bash(cmd:*)` (canonical
// prefix) and `Bash(cmd *)` (glob) route correctly under acceptEdits+--settings.
// We use the canonical colon form. Settings merge ADDITIVELY with the operator's
// own ~/.claude + project .claude rules (we never replace them).
//
// IMPORTANT: only inject this when the permission-prompt-tool is also wired
// (i.e. a session/thread the UI is watching exists). With no responder, an `ask`
// rule resolves to deny — which would silently block dangerous commands instead
// of prompting. claude-code.ts gates both behind the same `if (permSid)`.

export interface ClaudePermissionSettings {
  permissions: {
    ask: string[];
    deny: string[];
  };
}

/** The forgeax "dangerous ops" policy for the claude-code provider.
 *  - `ask`  → pops the Studio approval card (user allow/deny) before running.
 *  - `deny` → blocked outright (no card) for catastrophic, never-legit commands.
 *  Out-of-workspace reads/writes are intentionally NOT listed: acceptEdits
 *  already routes those to the prompt tool on its own (verified). */
export function buildForgeaxClaudeSettings(): ClaudePermissionSettings {
  return {
    permissions: {
      ask: [
        // Destructive file ops
        'Bash(rm:*)',
        'Bash(rmdir:*)',
        // Privilege escalation
        'Bash(sudo:*)',
        'Bash(doas:*)',
        // Outbound / history-rewriting git
        'Bash(git push:*)',
        'Bash(git reset --hard:*)',
        'Bash(git clean:*)',
        // Permission / ownership changes
        'Bash(chmod:*)',
        'Bash(chown:*)',
        // Network egress (exfil / arbitrary download)
        'Bash(curl:*)',
        'Bash(wget:*)',
        'Bash(ssh:*)',
        'Bash(scp:*)',
        'Bash(nc:*)',
        // Process control (could kill the studio stack itself)
        'Bash(kill:*)',
        'Bash(pkill:*)',
        'Bash(killall:*)',
        // Publishing / releasing
        'Bash(npm publish:*)',
        'Bash(pnpm publish:*)',
        'Bash(yarn publish:*)',
      ],
      deny: [
        // Catastrophic — never a legitimate game-dev action; block without a card.
        'Bash(dd:*)',
        'Bash(mkfs:*)',
        'Bash(shred:*)',
        'Bash(rm -rf /:*)',
        'Bash(rm -rf ~:*)',
        'Bash(sudo rm:*)',
      ],
    },
  };
}
