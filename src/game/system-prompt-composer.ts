/** GameSystemPromptComposer — the studio shell's implementation of the cli
 *  SystemPromptComposer seam (Stage A §3.2). It wraps the game-authoring charter
 *  builder + the environment renderer + the active-game note builder (all of
 *  which now live in the shell, not in the business-agnostic cli).
 *
 *  Injected once at boot via ProductContext.systemPromptComposer. The cli reads
 *  it through getSystemPromptComposer() on the hot path; when no shell injects
 *  one (standalone game-agnostic cli) every method simply isn't called and the
 *  charter is absent.
 *
 *  Byte-equivalence: each method returns exactly what the old in-cli builders
 *  returned for the same inputs, so the assembled system prompt is identical to
 *  the pre-seam build (the consumers keep the historical order). `charter()` is
 *  memoized — ports are fixed at construction, so it is byte-stable across turns
 *  (the prompt-cache anchor). */

import type { SystemPromptComposer } from 'forgeax-cli/orchestration-seams';
import { buildGameCharter, buildActiveGameNote } from './game-charter';
import { renderEnvironmentText } from './environment';

export class GameSystemPromptComposer implements SystemPromptComposer {
  private readonly _charter: string;

  constructor(ports: { serverPort: string; interfacePort: string }) {
    // Built once: ports are fixed for the process lifetime, so the charter is
    // byte-stable across every turn (prompt-cache prefix anchor).
    this._charter = buildGameCharter(ports);
  }

  charter(): string {
    return this._charter;
  }

  activeGameNote(slug: string | undefined): string {
    return buildActiveGameNote(slug);
  }

  environment(opts: { cwd: string; projectRoot?: string; slug?: string | null }): string {
    return renderEnvironmentText(opts);
  }
}
