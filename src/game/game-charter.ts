import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_STUDIO_HOST_CAPABILITIES,
  type StudioHostCapabilities,
} from "./studio-host-capabilities";

export interface GameCharterPorts {
  serverPort: string;
  interfacePort: string;
}

export function gameCharterTemplatePath(
  resourceRoot = process.env.FORGEAX_STARTUP_PROFILE === "desktop-prod"
    ? process.env.FORGEAX_RESOURCE_ROOT?.trim()
    : undefined,
  moduleUrl = import.meta.url,
): string | URL {
  return resourceRoot
    ? join(resourceRoot, "server-runtime", "assets", "game-charter.md")
    : new URL("./game-charter.md", moduleUrl);
}

const GAME_CHARTER_TEMPLATE = readFileSync(gameCharterTemplatePath(), "utf8").trimEnd();
const EDITOR_RELAY_BLOCK = /<!-- forgeax:editor-relay:start -->[\s\S]*?<!-- forgeax:editor-relay:end -->\n?/g;
const EDITOR_RELAY_MARKER = /<!-- forgeax:editor-relay:(?:start|end) -->\n?/g;

/**
 * Load the game-authoring contract from its Markdown SSOT and bind the live
 * Studio ports used by the verify and preview instructions.
 */
export function buildGameCharter(
  { serverPort, interfacePort }: GameCharterPorts,
  capabilities: StudioHostCapabilities = DEFAULT_STUDIO_HOST_CAPABILITIES,
): string {
  const capabilityBound = capabilities.editorRelay.available
    ? GAME_CHARTER_TEMPLATE.replaceAll(EDITOR_RELAY_MARKER, "")
    : GAME_CHARTER_TEMPLATE.replaceAll(EDITOR_RELAY_BLOCK, "");
  return capabilityBound
    .replaceAll("{{serverPort}}", serverPort)
    .replaceAll("{{interfacePort}}", interfacePort);
}

/**
 * Active-game scoping note appended after the charter. When the studio has a
 * current active game, ambiguous edits scope to that slug; an explicit request
 * for a new game still scaffolds a new slug.
 */
export function buildActiveGameNote(activeSlug?: string): string {
  if (!activeSlug) return "";
  return `The currently-active game is \`${activeSlug}\` (at \`.forgeax/games/${activeSlug}/\`). This session is bound to that game. If the user asks to modify "the game", "this game", or just describes changes without naming a slug, edit files in that directory. Any document, validation note, design note, or other artifact requested as part of work on this active game also belongs under that game root; repository-level \`docs/\` is not a game deliverable unless the user explicitly asks for repository documentation. If they explicitly say "做个新的X game" / "create a new game", scaffold a new slug instead.`;
}
