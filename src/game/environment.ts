/**
 * environment 渲染器(纯函数)—— system prompt 的 `# Environment` 段:
 * Paths + 当前游戏 + Extension 插件表 + Skills 目录。
 *
 * 单一真相:`builtin/kits/workspace/slots/environment.ts`(老 slot 路径)与
 * `src/kernel/compose-turn-request.ts`(新内核装配器)都从这里 import,**只产文本**。
 * 依赖方向与 `game-charter.ts` 一致:逻辑在 src,builtin 薄壳 import src(单向,无环)。
 * Boundary: 仅 import src-local + @forgeax/types,绝不反向依赖 builtin。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { defaultProjectRoot, assetRoot } from '@forgeax/platform-io';
import { resolveEngineTemplatesRoot } from './game-templates';
import { getExtensionSnapshot } from "@forgeax/orchestrator/extensions";
import { pickI18n } from "@forgeax/types";
import { installedExtensionPages } from './installed-extension-pages';

interface ForgeJson {
  id?: string;
  name?: string;
  entry?: string;
}

function readForgeJson(gameRoot: string): ForgeJson | null {
  const p = join(gameRoot, "forge.json");
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ForgeJson;
  } catch {
    return null;
  }
}

function inferGameSlug(cwd: string, projectRoot: string): string | null {
  const rel = relative(projectRoot, cwd);
  const m = rel.match(/^\.forgeax\/games\/([^/]+)$/);
  return m ? m[1] : null;
}

export interface RenderEnvironmentOpts {
  /** 报给模型的「Working directory」。新内核路径 = 项目根(file 工具相对此解析);
   *  老 slot 路径 = 会话 cwd(游戏目录)。 */
  cwd: string;
  /** 缺省 defaultProjectRoot()。 */
  projectRoot?: string;
  /** 显式游戏 slug;缺省从 cwd 推断(仅老路径 cwd==游戏目录时有效)。 */
  slug?: string | null;
}

/** 纯函数渲染 environment 文本(Paths + Game + Extension 插件 + Skills)。
 *  老 slot(`environmentSlot`)与新内核装配器(`composeTurnRequest`)共用,单一真相。 */
export function renderEnvironmentText(opts: RenderEnvironmentOpts): string {
  const projectRoot = opts.projectRoot ?? defaultProjectRoot();
  const cwd = opts.cwd;
  const slug = opts.slug ?? inferGameSlug(cwd, projectRoot);
  const gameRoot = slug ? join(projectRoot, ".forgeax", "games", slug) : null;
  const forge = gameRoot ? readForgeJson(gameRoot) : null;

  const lines: string[] = [];
  lines.push("# Environment");
  lines.push("");

  // Paths
  lines.push("## Paths");
  lines.push(`- Working directory: ${cwd}`);
  lines.push(`- Instance root: ${projectRoot}`);
  if (slug) {
    lines.push(`- Game slug: ${slug}`);
    lines.push(`- Game dir: .forgeax/games/${slug}/`);
    lines.push(`- Project skills: ${join(gameRoot!, 'skills')}`);
    const engineRoot = dirname(resolveEngineTemplatesRoot());
    lines.push(`- Matching Engine reference root: ${engineRoot}`);
    const packagedTypes = join(assetRoot(), 'engine', 'node_modules', '@forgeax');
    lines.push(`- Engine API packages: ${existsSync(packagedTypes) ? packagedTypes : join(engineRoot, 'packages')}`);
    lines.push('');
    lines.push('## Studio embedded project authoring');
    lines.push('This game has already been created by Studio. Work in its existing entry and assets; SDK init/new and SDK ZIP production are not part of this workflow.');
    lines.push('The Engine CLI is not registered on PATH by this App. Do not use a global forgeax executable or install another SDK to guess the matching version.');
    lines.push(`Project skill documents are files at ${join(gameRoot!, 'skills', '<skill-id>', 'SKILL.md')}; a skill directory is not a readable document.`);
    lines.push('Start with the installed skill relevant to the next implementation decision: forgeax-engine-app for integration, forgeax-engine-ecs for behavior, or forgeax-engine-assets for asset authoring. Reuse instructions already read; load other skills only when the task needs them.');
    lines.push('Use those examples and the existing entry first. Query the matching Engine API packages only to resolve a specific unanswered API question or observed error; avoid surveying the SDK or unrelated games before implementing.');
    lines.push('Studio owns the host, World and frame loop: extend the provided bootstrap/world instead of creating a second host or World from standalone skill examples.');
    lines.push('Use the Studio tools actually exposed in this session for editing and Play, then observe the result. SDK onboarding.read and root AGENTS.md are not supplied by this project-creation path; do not search for them as prerequisites.');
  }
  lines.push("");

  // Game info
  if (forge) {
    lines.push("## Game");
    if (forge.entry) lines.push(`- Entry: ${forge.entry}`);
    if (forge.name && forge.name !== slug) lines.push(`- Name: ${forge.name}`);
    lines.push("");
  }

  // Extension plugins + skills
  const snap = getExtensionSnapshot();
  const pages = installedExtensionPages(snap);
  const skills = snap.kinds.skills;

  if (pages.length > 0 || skills.length > 0) {
    // Extension table
    if (pages.length > 0) {
      lines.push("## Extension extensions");
      lines.push("| id | data dir | skills |");
      lines.push("| --- | --- | --- |");
      for (const wb of pages) {
        const wbSkills = skills
          .filter((s) => s.extensionId === wb.extensionId)
          .map((s) => {
            const trigger = s.definition.triggers?.[0];
            if (trigger && trigger.kind === "slash") return `/${trigger.command}`;
            return s.definition.id;
          });
        const dataDir = slug ? inferDataDir(wb.pageId, slug) : "—";
        const skillStr = wbSkills.length > 0 ? wbSkills.join(", ") : "—";
        lines.push(`| ${wb.pageId} | ${dataDir} | ${skillStr} |`);
      }
      lines.push("");
    }

    // Skills list (including non-extension skills)
    if (skills.length > 0) {
      lines.push("## Skills");
      for (const s of skills) {
        const trigger = s.definition.triggers?.[0];
        const cmd = trigger && trigger.kind === "slash" ? `/${trigger.command}` : s.definition.id;
        const desc = pickI18n(s.definition.description, "zh") || pickI18n(s.definition.displayName, "zh") || "";
        const short = desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
        lines.push(`- \`${cmd}\` — ${short} (${s.extensionId.replace("@forgeax-extension/", "")})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function inferDataDir(pageId: string, slug: string): string {
  // Known conventions for per-game plugin data directories.
  // Keys are extension ids as the scanner reports them, i.e. AFTER the
  // marketplace `` convergence (LEGACY_EXTENSION_SLUG_MIGRATIONS in
  // @forgeax/orchestrator normalizes the pre-rename ids to these). Values are
  // directories inside the game and are NOT affected by that rename.
  const known: Record<string, string> = {
    character: `characters/`,
    "scene": `scene/`,
    narrative: `design/`,
    anim: `anim/`,
    bgm: `audio/`,
    items: `items/`,
    "lowpoly-obj": `lowpoly-characters/`,
    ui: `ui/`,
  };
  const sub = known[pageId];
  if (sub) return `.forgeax/games/${slug}/${sub}`;
  return "—";
}
