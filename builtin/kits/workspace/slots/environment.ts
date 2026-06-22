import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import { getActiveGame } from "../../../../src/api/lib/active-game";
import { getPluginSnapshot } from "../../../../src/plugins/registry";
import { pickI18n } from "@forgeax/types";
import { loadGameProjectSync } from "@forgeax/engine-project";

function inferGameSlug(cwd: string, projectRoot: string): string | null {
  const rel = relative(projectRoot, cwd);
  const m = rel.match(/^\.forgeax\/games\/([^/]+)$/);
  return m ? m[1] : null;
}

function renderEnvironment(ctx: AgentContext): string {
  const projectRoot = defaultProjectRoot();
  const cwd = ctx.cwd;
  let slug = inferGameSlug(cwd, projectRoot);
  if (!slug) slug = getActiveGame(projectRoot) ?? null;
  // Pre-resolve forge.json name synchronously (ContentSlot is sync API).
  // Uses FORGE_JSON constant (SSOT path) from @forgeax/engine-project.
  let forgeName: string | null = null;
  if (slug) {
    const gameRoot = slug === inferGameSlug(cwd, projectRoot) ? cwd : join(projectRoot, ".forgeax/games", slug);
    const r = loadGameProjectSync(p => readFileSync(join(gameRoot, p), "utf-8"));
    if (r.ok) {
      forgeName = r.value.name;
    }
    // loader returns structured error on !r.ok — forgeName=null is the
    // intended fallback when forge.json is missing/invalid (environment
    // panel shows no game name rather than a fabricated one).
  }

  const lines: string[] = [];
  lines.push("# Environment");
  lines.push("");

  // Paths
  lines.push("## Paths");
  lines.push(`- Working directory: ${cwd}`);
  lines.push(`- Project root: ${projectRoot}`);
  if (slug) {
    lines.push(`- Game slug: ${slug}`);
    lines.push(`- Game dir: .forgeax/games/${slug}/`);
  }
  lines.push("");

  // Game info — name is the only consumed forge.json field (F-1).
  if (forgeName) {
    lines.push("## Game");
    if (forgeName !== slug) lines.push(`- Name: ${forgeName}`);
    lines.push("");
  }

  // Workbench plugins + skills
  const snap = getPluginSnapshot();
  const workbenches = snap.kinds.workbench;
  const skills = snap.kinds.skills;

  if (workbenches.length > 0 || skills.length > 0) {
    // Workbench table
    if (workbenches.length > 0) {
      lines.push("## Workbench plugins");
      lines.push("| id | data dir | skills |");
      lines.push("| --- | --- | --- |");
      for (const wb of workbenches) {
        if (wb.hidden) continue;
        const wbSkills = skills
          .filter((s) => s.pluginId === wb.pluginId)
          .map((s) => {
            const trigger = s.definition.triggers?.[0];
            if (trigger && trigger.kind === "slash") return `/${trigger.command}`;
            return s.definition.id;
          });
        const dataDir = slug ? inferDataDir(wb.workbenchId, slug) : "—";
        const skillStr = wbSkills.length > 0 ? wbSkills.join(", ") : "—";
        lines.push(`| ${wb.workbenchId} | ${dataDir} | ${skillStr} |`);
      }
      lines.push("");
    }

    // Skills list (including non-workbench skills)
    if (skills.length > 0) {
      lines.push("## Skills");
      for (const s of skills) {
        const trigger = s.definition.triggers?.[0];
        const cmd = trigger && trigger.kind === "slash" ? `/${trigger.command}` : s.definition.id;
        const desc = pickI18n(s.definition.description, "zh") || pickI18n(s.definition.displayName, "zh") || "";
        const short = desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
        lines.push(`- \`${cmd}\` — ${short} (${s.pluginId.replace("@forgeax-plugin/", "")})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function inferDataDir(workbenchId: string, slug: string): string {
  // Known conventions for per-game plugin data directories
  const known: Record<string, string> = {
    "wb-character": `characters/`,
    "wb-scene": `wb-scene/`,
    "wb-narrative": `design/`,
    "wb-anim": `anim/`,
    "wb-bgm": `audio/`,
    "wb-items": `items/`,
    "wb-lowpoly-obj": `lowpoly-characters/`,
    "wb-ui": `ui/`,
  };
  const sub = known[workbenchId];
  if (sub) return `.forgeax/games/${slug}/${sub}`;
  return "—";
}

export default function environmentSlot(ctx: AgentContext): ContextSlot {
  return {
    name: "environment",
    description:
      "Resolved session paths, game info, installed workbench plugins, " +
      "and available skills. Lets the LLM know where it is working without " +
      "needing to run shell commands.",
    priority: SlotPriority.STATIC_ENVIRONMENT,
    cacheHint: "stable",
    version: 1,
    content: renderEnvironment(ctx),
  };
}
