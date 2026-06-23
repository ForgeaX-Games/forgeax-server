/** CliProviders 装配入口（精简版 · 2026-05-20）。
 *
 *  服务于独立 REST 分支 `/api/cli/*`。Boot 时由 main.ts 调 `bootCliProviders()`
 *  一次，挂 claude-code 为 default。
 *
 *  其他 provider（codex / cursor-agent / forgeax-cli）后续按需在这里再加 `register`。
 */

import { ClaudeCodeProvider } from "./providers/claude-code";
import { CodexProvider } from "./providers/codex";
import { CursorAgentProvider } from "./providers/cursor-agent";
import { forgeaxNativeDriver } from "./providers/forgeax-native";
import { registerProvider, listProviders } from "./registry";
import { registerDriver, listDrivers } from "@forgeax/agent-runtime";

export async function bootCliProviders(): Promise<void> {
  const claude = new ClaudeCodeProvider();
  // 不读 process.env 显式覆盖 —— ANTHROPIC_API_KEY / ANTHROPIC_CLI_PATH 由
  // provider 自己 fallback 到 env，cfg.options.binary / cfg.env 留给将来 settings UI。
  await claude.init({});
  registerProvider(claude, { default: true });

  // Codex — OpenAI Codex CLI (`codex`). Non-default: claude-code stays the
  // default backend. Registered unconditionally so it surfaces in the Studio
  // composer's provider dropdown; health() reports missing binary / auth so an
  // unconfigured codex shows greyed rather than absent. Picks up
  // OPENAI_API_KEY / OPENAI_BASE_URL from keys.yaml `codex` route or env, or a
  // `codex login` session.
  const codex = new CodexProvider();
  await codex.init({});
  registerProvider(codex);

  // Cursor — Cursor's `cursor-agent` CLI. Non-default, registered
  // unconditionally so it shows in the composer's provider dropdown; health()
  // reports missing binary / auth. Picks up CURSOR_API_KEY from keys.yaml
  // `cursor` route or env, or a `cursor-agent login` session. Approval gating
  // is via .cursor/hooks.json → cursor-permission-hook.mjs (see provider).
  const cursor = new CursorAgentProvider();
  await cursor.init({});
  registerProvider(cursor);

  // Phase C2 — register the new-contract Driver into @forgeax/agent-runtime so
  // the C3 cli-provider KindLoader and SettingsPanel · CLI Providers (C7) can
  // surface the bottom-of-stack fallback. The legacy CliProvider registry
  // above stays for `/api/cli/*` until C3 finishes the swap.
  registerDriver(forgeaxNativeDriver);

  const provIds = listProviders().map((p) => p.id);
  const driverIds = listDrivers().map((d) => d.id);
  console.log(
    `[forgeax-server] cli-providers registered: ${provIds.join(", ") || "(none)"} · ` +
      `drivers: ${driverIds.join(", ") || "(none)"}`,
  );
}
