/** Stage A §7 golden harness — guards that the injected GameSystemPromptComposer
 *  produces BYTE-IDENTICAL output to the raw builders it wraps, and that the
 *  charter (the prompt-cache prefix, §3.2) is byte-stable across calls.
 *
 *  Why this matters: the charter/environment/note used to be built inline in
 *  @forgeax/orchestrator (compose-turn-request + claude-code provider). Stage A moved the
 *  builders into the shell behind the SystemPromptComposer seam. If the composer
 *  ever drifts from the builders, the system prompt changes silently — breaking
 *  both "zero behavior change" and (for the charter) prompt-cache hit rate, which
 *  a single golden diff of the assembled prompt would NOT catch (it's a
 *  cross-turn stability property). */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GameSystemPromptComposer } from '../src/game/system-prompt-composer';
import {
  buildGameCharter,
  buildActiveGameNote,
  gameCharterTemplatePath,
} from '../src/game/game-charter';

const PORTS = { serverPort: '18900', interfacePort: '18920' };
const HEALTHY_EDITOR_RELAY = {
  editorRelay: {
    available: true,
    baseUrl: 'http://127.0.0.1:15295',
    reason: 'available',
  },
} as const;

describe('GameSystemPromptComposer — byte-equivalence + cache-stability (Stage A §7)', () => {
  test('resolves the packaged charter from the desktop resource root', () => {
    expect(gameCharterTemplatePath('/Applications/ForgeaX Studio.app/Contents/Resources/resources'))
      .toBe('/Applications/ForgeaX Studio.app/Contents/Resources/resources/server-runtime/assets/game-charter.md');
  });

  test('loads the game-authoring contract from the Markdown SSOT and binds live ports', () => {
    const markdown = readFileSync(new URL('../src/game/game-charter.md', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/game/game-charter.ts', import.meta.url), 'utf8');
    const charter = buildGameCharter(PORTS);

    expect(markdown).toContain('{{serverPort}}');
    expect(markdown).toContain('{{interfacePort}}');
    expect(markdown).toContain('You are running inside forgeax-studio');
    expect(source).not.toContain('You are running inside forgeax-studio');
    expect(charter).toContain('http://127.0.0.1:18900');
    expect(charter).toContain('http://127.0.0.1:18920');
    expect(charter).toContain('Asset graph');
    expect(charter).toContain('editor_transport');
    expect(charter).toContain('Continuous maturity');
    expect(charter).toContain('Do not assume `src/`, `main.ts`, `scene.pack.json`');
    expect(charter).not.toContain('{{serverPort}}');
    expect(charter).not.toContain('{{interfacePort}}');
  });

  // A silent build used to pass as finished: nothing in the charter said audio
  // belonged to the first loop, and forge only dispatched `audio-designer` when
  // the user said an audio word out loud. This clause is what makes "make me an
  // X game" reach the audio pass on its own, so it must not silently drop out.
  test('counts the audio layer as part of a finished playable slice', () => {
    const charter = buildGameCharter(PORTS);

    expect(charter).toContain('A playable slice is not finished while the game is still silent');
    expect(charter).toContain('belongs to the first complete loop');
    // The nine-step authoring chain stays in the BGM/SFX extension skill — the charter
    // points at it instead of growing a second copy.
    expect(charter).toContain('forgeax:game-audio');
  });

  // The charter used to call BOTH `editor_transport` and `editor_ui_browse` "the
  // default editor integration", and only the first one works without the DEV
  // loopback relay. A 185-turn run burned itself on repository source archaeology
  // after `editor_ui_browse` answered EDITOR_TRANSPORT_DOWN on its very first
  // call, then aborted on the consecutive-failure breaker. Pin both halves of the
  // fix: exactly one default, plus a stated route when the relay is absent.
  test('includes relay guidance only when the capability was healthy at boot', () => {
    const charter = buildGameCharter(PORTS, HEALTHY_EDITOR_RELAY);

    expect(charter.match(/is the default editor integration/g) ?? []).toHaveLength(1);
    expect(charter).toContain('`editor_transport` is the default editor integration');
    expect(charter).toContain('EDITOR_TRANSPORT_DOWN');
    expect(charter).toContain('Never compensate for its absence by reading repository source');

    const noRelay = buildGameCharter(PORTS);
    expect(noRelay).toContain('`editor_transport` is the default editor integration');
    expect(noRelay).not.toContain('editor_ui_browse');
    expect(noRelay).not.toContain('editor_gateway_eval');
    expect(noRelay).not.toContain('EDITOR_TRANSPORT_DOWN');
    expect(noRelay).not.toContain('127.0.0.1:15295');
    expect(noRelay).not.toContain('forgeax:editor-relay');
  });

  test('includes the task execution protocol in the loaded charter', () => {
    const charter = buildGameCharter(PORTS);

    expect(charter).toContain('## Task execution protocol');
    expect(charter).toContain('use `ask_user` before editing');
    expect(charter).toContain('call `todo_write` with the complete plan: 1–6 items');
    expect(charter).toContain('stable `id` and an `activeForm`');
    expect(charter).toContain('exactly one item `in_progress` at a time');
    expect(charter).toContain('`id` and `content` byte-identical');
    expect(charter).toContain('independent artifact card');
    expect(charter).toContain('`deliver_summary` is optional');
    expect(charter).toContain('private chain-of-thought');
  });

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
    expect(composer.activeGameNote('my-game')).toContain('repository-level `docs/` is not a game deliverable');
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
