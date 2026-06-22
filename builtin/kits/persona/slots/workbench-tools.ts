/** workbench-tools slot — 为 manifest 声明了 `provides.agent.tools[]` 的
 *  驻场 agent 注入「可用工具 + active game + 强制工作流」，避免 LLM
 *  在看不见 tool schema 时退化成问卷/纯文本助手。 */

import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { lookupAgent, resolveAgentIdAlias } from "../../../../src/agents/loader";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import { getActiveGame } from "../../../../src/api/lib/active-game";

function lastSegment(agentPath: string): string {
  const segs = agentPath.split("/");
  return segs[segs.length - 1] ?? agentPath;
}

function bridgeToolName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export default function workbenchToolsSlot(_ctx: AgentContext): ContextSlot | null {
  return {
    name: "workbench-tools",
    description:
      "Inject host-bridged workbench tool names, active game slug, and " +
      "mandatory first-turn workflow for plugin agents that declare tools[].",
    priority: SlotPriority.STATIC_CORE,
    cacheHint: "stable",
    version: 1,
    content: () => {
      const agentId = resolveAgentIdAlias(lastSegment(_ctx.agentPath));
      const entry = lookupAgent(agentId);
      const manifestTools = entry?.definition.tools ?? [];
      if (manifestTools.length === 0) return "";

      const projectRoot = defaultProjectRoot();
      const slug = getActiveGame(projectRoot) ?? "_default";
      const bridged = manifestTools.map(bridgeToolName);

      return [
        "# Workbench Tools (你已接入，禁止声称没有)",
        "",
        "以下工具已在当前 forgeax-native 会话中注册，**第一轮就必须调用**，",
        "不要向用户索要项目路径 / Unity / Godot / 分辨率问卷：",
        "",
        ...bridged.map((name) => `- \`${name}\``),
        "",
        "## 当前工作区",
        `- Project root: \`${projectRoot}\``,
        `- Active game slug: \`${slug}\`（character:* 的 \`slug\` 参数用这个）`,
        `- 角色资产目录: \`.forgeax/games/${slug}/characters/<charId>/\``,
        "",
        "## 用户说「画立绘 / 红斗篷骑士」时的固定流程",
        `1. \`character_list\` — \`{ "slug": "${slug}" }\``,
        `2. \`character_generate-portrait\` — \`{ "slug": "${slug}", "prompt": "<用户描述>", "style": "anime-hd-flat", "views": ["front"] }\``,
        "",
        "禁止：HTML5 Canvas / SVG 独立预览、让用户手动给磁盘路径、重复索要引擎信息。",
        "工具失败时：原样汇报 error JSON，并建议检查 GEMINI_API_KEY / Seedream 与 forgeax-server 是否重启。",
      ].join("\n");
    },
    condition: (ctx) => {
      const agentId = resolveAgentIdAlias(lastSegment(ctx.agentPath));
      const entry = lookupAgent(agentId);
      return (entry?.definition.tools?.length ?? 0) > 0;
    },
  };
}
