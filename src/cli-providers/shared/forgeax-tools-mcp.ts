// Shared wiring for the forgeax-tools MCP server (mcp/forgeax-tools-server.mjs)
// — the ONE way every external CLI provider exposes forgeax host tools (wb-bgm
// today) to its agent. Providers inject MCP differently (claude --mcp-config /
// cursor .cursor/mcp.json / codex config), but all register the SAME entry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Stable key used for this server in every provider's MCP config. */
export const FORGEAX_TOOLS_MCP_NAME = 'forgeax-tools';

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Build the `{command,args,env}` entry that runs forgeax-tools-server.mjs.
 *  `importMetaDir` is the calling provider's import.meta.dir (sibling mcp/).
 *  `agentId` (when given) is forwarded as FORGEAX_AGENT so the MCP filters the
 *  Host ToolRegistry to that agent's `provides.agent.tools` whitelist (parity
 *  with the native host_tool_bridge) instead of exposing the whole catalog. */
export function forgeaxToolsServerEntry(
  importMetaDir: string,
  nodeBin: string,
  serverPort: string,
  agentId?: string,
): McpServerEntry {
  return {
    command: nodeBin,
    args: [resolvePath(importMetaDir, '../mcp/forgeax-tools-server.mjs')],
    env: {
      FORGEAX_SERVER_URL: `http://127.0.0.1:${serverPort}`,
      ...(agentId && agentId.trim() ? { FORGEAX_AGENT: agentId.trim() } : {}),
    },
  };
}

/** Merge the entry into <projectRoot>/.cursor/mcp.json under FORGEAX_TOOLS_MCP_NAME
 *  without clobbering operator-defined servers. Best-effort (never throws). */
export function ensureCursorMcpServer(projectRoot: string, entry: McpServerEntry): void {
  try {
    const cursorDir = resolvePath(projectRoot, '.cursor');
    const cfgPath = resolvePath(cursorDir, 'mcp.json');
    let cfg: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) ?? {}; } catch { cfg = {}; }
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
    cfg.mcpServers[FORGEAX_TOOLS_MCP_NAME] = entry;
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn(`[forgeax-tools-mcp] cursor mcp.json wiring failed: ${(e as Error).message}`);
  }
}
