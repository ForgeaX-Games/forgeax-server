import { readFileSync } from "node:fs";

export interface GameCharterPorts {
  serverPort: string;
  interfacePort: string;
}

const GAME_CHARTER_TEMPLATE = readFileSync(
  new URL("./game-charter.md", import.meta.url),
  "utf8",
).trimEnd();

/**
 * Load the game-authoring contract from its Markdown SSOT and bind the live
 * Studio ports used by the verify and preview instructions.
 */
export function buildGameCharter({ serverPort, interfacePort }: GameCharterPorts): string {
  return GAME_CHARTER_TEMPLATE
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
  return `The currently-active game is \`${activeSlug}\` (at \`.forgeax/games/${activeSlug}/\`). If the user asks to modify "the game", "this game", or just describes changes without naming a slug, edit files in that directory. If they explicitly say "做个新的X game" / "create a new game", scaffold a new slug instead.`;
}
