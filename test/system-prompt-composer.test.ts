/** Stage A §7 golden harness — guards that the injected GameSystemPromptComposer
 *  produces BYTE-IDENTICAL output to the raw builders it wraps, and that the
 *  charter (the prompt-cache prefix, §3.2) is byte-stable across calls.
 *
 *  Why this matters: the charter/environment/note used to be built inline in
 *  forgeax-cli (compose-turn-request + claude-code provider). Stage A moved the
 *  builders into the shell behind the SystemPromptComposer seam. If the composer
 *  ever drifts from the builders, the system prompt changes silently — breaking
 *  both "zero behavior change" and (for the charter) prompt-cache hit rate, which
 *  a single golden diff of the assembled prompt would NOT catch (it's a
 *  cross-turn stability property). */

import { describe, test, expect } from 'bun:test';
import { GameSystemPromptComposer } from '../src/game/system-prompt-composer';
import { buildGameCharter, buildActiveGameNote } from '../src/game/game-charter';

const PORTS = { serverPort: '18900', interfacePort: '18920' };

describe('GameSystemPromptComposer — byte-equivalence + cache-stability (Stage A §7)', () => {
  test('charter() === buildGameCharter(ports) — composer does not drift from the builder', () => {
    const composer = new GameSystemPromptComposer(PORTS);
    expect(composer.charter()).toBe(buildGameCharter(PORTS));
  });

  test('charter() is byte-stable across calls (prompt-cache prefix invariant §3.2)', () => {
    const composer = new GameSystemPromptComposer(PORTS);
    const a = composer.charter();
    const b = composer.charter();
    expect(b).toBe(a);
  });

  test('activeGameNote(slug) === buildActiveGameNote(slug) for present + absent slug', () => {
    const composer = new GameSystemPromptComposer(PORTS);
    expect(composer.activeGameNote('my-game')).toBe(buildActiveGameNote('my-game'));
    expect(composer.activeGameNote(undefined)).toBe(buildActiveGameNote(undefined));
    expect(composer.activeGameNote(undefined)).toBe(''); // no active game ⇒ empty
  });

  test('assembled charter block matches the historical [charter, env, note] composition', () => {
    const composer = new GameSystemPromptComposer(PORTS);
    const slug = 'my-game';
    // compose-turn-request composes: [charter(), environment, note].filter(non-empty).join('\n\n').
    // environment needs plugin-registry boot, so this golden uses '' for it (the
    // best-effort fallback path) — the charter+note ordering is what we pin here.
    const note = composer.activeGameNote(slug);
    const assembled = [composer.charter(), '', note].filter((s) => s && s.trim()).join('\n\n');
    const expected = [buildGameCharter(PORTS), buildActiveGameNote(slug)]
      .filter((s) => s && s.trim())
      .join('\n\n');
    expect(assembled).toBe(expected);
  });
});
