// Product-owned guidance is bundled into Server and installed with project skills.
export const STUDIO_GAME_AUTHORING_SKILL = `---
name: forgeax-studio-game-authoring
description: Implement or verify an existing hosted Studio game. Use for gameplay/HUD changes and Play acceptance; focus the ready canvas, hold player input across frames, and check observable scoring and restart.
---

# Studio game authoring

Use the active game's \`forge.json\`, \`src/main.ts\` and declared dependencies as the versioned entry points. Preserve their loader and asset conventions. Read the relevant row below; the full Engine catalog is for an unknown capability, not routine preparation.

| Current change | Read or use | Smallest useful proof |
| --- | --- | --- |
| Input, frame time, app lifecycle | [Engine app](../forgeax-engine-app/SKILL.md), then the existing project's input and update system | An actual key or pointer input changes gameplay in Play |
| Gameplay state and rules | [Engine ECS](../forgeax-engine-ecs/SKILL.md); [state](../forgeax-engine-state/SKILL.md) only when needed | Core scoring or win/loss rule and restart work |
| Scene, asset identity, references | [Engine assets](../forgeax-engine-assets/SKILL.md) and existing project asset entries | Authored scene and referenced assets appear in Play |
| HUD implementation | Discover the current editor UI authoring operation and read its schema; follow the project's declared Engine UI public types | Submit the UI through its authoring validation, then mount and update it from gameplay |
| Audio preparation and integration | The available BGM extension's \`forgeax-game-audio\` skill and \`verify-audio-project\` tool | Preparation, integration and real playback evidence are distinct |
| A concrete runtime failure | [Engine debug](../forgeax-engine-debug/SKILL.md), scoped to the observed error | Repeat the failing player action after the repair |

## Studio host boundary

The active Studio game exports a Plugin; the host already owns App, World and platform backends. Engine skills may also describe building a standalone host with createApp. Those standalone bootstrap examples are not prerequisites for editing this hosted game.

For requested BGM/SFX, delegate preparation to the available audio specialist in the first work plan with expected event names and the game directory. The specialist owns the BGM extension tools, asset preparation and generated src/forgeax-audio runtime; the main implementation owner supplies the actual gameplay hooks and integrates its public exports. Do not investigate audioPlugin/AudioBackend installation before that handoff or create a second audio backend. A concrete playback error can justify a scoped diagnostic after integration.

Reuse valid starter scene assets for the first playable checkpoint. Make the smallest behavior and visible-feedback change that exercises the requested rule, then refine the authored scene and final presentation. Missing independent audio/design output does not block that checkpoint; final delivery still requires those requested features and actual validation.

When a specialist changes an asset pack, its delivery includes the pack's complete dependency declaration. Every external GUID referenced by any returned asset or read through AssetReader must be declared in externalAssets; definitions inside the same pack are not external dependencies. This declaration must equal the actual dependency closure: when removing scene entities, also remove externalAssets entries no longer referenced by any output or AssetReader read. Preserve shared references still used by other outputs. If the pack still returns the starter scene alongside a new scene, validate the dependencies of both outputs. Read the asset compiler diagnostics before switching forge.json.defaultScene. A scene missing from the runtime catalog can be a rejected pack: repair the reported missing or unused declarations rather than repeatedly retrying Play or changing the renderer. Calling the pack build() function or passing TypeScript alone does not validate this closure; confirm the asset compiler accepts the complete pack before reporting it ready.

## Common gameplay contracts

For the Studio Game3D template, keep the exported Plugin and its injected world/gameHost. The host loads forge.json.defaultScene before apply(ctx). Extend the existing scene and systems; do not create a second App or World. Copy the current entry's input and cleanup pattern instead of rediscovering it across Engine internals.

The current public ECS resource API is insertResource(key, value), getResource<T>(key), hasResource(key), removeResource(key). insertResource inserts or overwrites and returns void; getResource throws for a missing key. Ordinary shared score/timer state can be a resource; it does not require a managed shared reference. Use a game-specific key and remove it with the plugin's other cleanup.

\`\`\`ts
import { FixedTime, FixedUpdate, type World } from '@forgeax/engine/ecs';

export function installRound(world: World): () => void {
  const key = 'bubble-range.round';
  world.insertResource(key, { score: 0, remaining: 60 });
  world.addSystem(FixedUpdate, {
    name: 'bubble-range.round', queries: [],
    fn: () => {
      const round = world.getResource<{ score: number; remaining: number }>(key);
      round.remaining = Math.max(0, round.remaining - world.getResource(FixedTime).delta);
    },
  }).unwrap();
  return () => {
    world.removeSystem(FixedUpdate, 'bubble-range.round').unwrap();
    world.removeResource(key);
  };
}
\`\`\`

Register the returned cleanup through the existing Plugin ctx.effect lifecycle. This is a state/timer example, not a complete game: connect movement, hit scoring and visible feedback in the existing entry before the first Play. Keyboard held input uses input.keyboard.downCode('KeyA'); physics movement belongs in FixedUpdate with FixedTime, visual updates use the entry's Update/Time pattern. Preserve the entry's component leases and authored entity lookup.

One-shot input edges such as fire or restart belong to the render-frame input snapshot. If gameplay runs in FixedUpdate, capture these edges once in an Update system after the input scan and before FixedUpdate, then consume the queued command once in FixedUpdate. Do not read justPressedCode directly on every fixed tick: a frame with no fixed tick loses the edge, while catch-up ticks can repeat it. Continuous movement can read the held-key state.

Use these names with the installed Engine public facade. If typecheck reports a changed signature, inspect that one public declaration and adapt; do not search the whole Engine for speculative alternative names. For example, a missing resource is a state initialization error, not evidence that setResource/addResource needs discovering.

For HUD work, the main implementation owner translates the designer's state, layout and interaction specification into the project's UI asset and bindings. Do not send HTML/CSS implementation back to a design-only role. Engine UI is not an unrestricted browser document: use the current authoring schema and supported elements/styles, not assumptions from ordinary web frameworks. Use the existing authoring operation's structured diagnostics to fix the affected asset; do not build a separate DOM validator or inspect renderer internals to guess support.

Agree on shared state/event names and output files in the first specialist handoff. Assign one implementation owner to each shared entry or asset pack; other roles deliver separate modules or specifications for that owner to integrate. Continue independent gameplay work while assets are prepared. Use incoming handoff/completion messages to collect results; query status when a dependency is blocked or a result is missing, rather than repeatedly sleeping and listing every role. An empty parent-repository git diff does not establish that a game has no changes: game directories can be ignored or independently versioned. A first Play checkpoint needs input, one core rule, visible feedback and restart; it need not wait for all presentation assets. Final delivery still requires the requested presentation, integrated audio and a real game interaction loop.

## Focused investigation

Read the skill row for the current change, then the required public declaration or project symbol. Carry resolved names and delivered file paths forward across handoffs. After a stop or compaction, inspect the changed files needed for the remaining task instead of restarting the full repository survey. Broaden a search when a specific missing symbol or diagnostic requires it.

For audio integration, start with the specialist's public exports, event IDs and declared runtime API. Read the relevant declaration when a signature is unclear; inspect generated runtime implementation only for a concrete error that the public contract cannot explain. Existing scene tests establish asset validity, not gameplay success.

## Player interaction verification

Enter Play through the normal Studio UI, wait for the game HUD or scene to be ready, and focus the game canvas before keyboard input. Keep key-down active across game frames before key-up; a human-scale tap (for example 100-200 ms) avoids missing an input sampled between frames. Release held keys even if the check fails.

Use the browser tool's advertised schema and execution API. In Playwright, keyboard belongs to page.keyboard; target the game frame for its canvas and HUD, and use page.waitForTimeout when a short input hold is needed. Do not substitute synthetic DOM events or mutate game state to claim a player action succeeded.

Observe the game frame rather than repeatedly snapshotting the full Studio page and its chat history. Use a targeted accessibility snapshot or visible HUD locators for the values being checked; expand to the surrounding Studio UI only when navigation or an error requires it. A canvas or shadow-root HUD may be absent from body.innerText, so empty document text is not proof that the game has no UI.

Compare integrated specialist output with the original user requirements before Play; a design proposal does not authorize changing explicit rules, options or limits. Check those requirements in the visible game as well as the core loop. Inspect actual rendered frames during movement and after releasing input: the requested camera perspective must remain usable, the player and threats must stay readable, and template showcase props must not obscure the game. A changing HUD, accepted key events, or a victory dialog alone does not prove visible movement or playable presentation.

Compare observable results before and after each action: movement, hit score, countdown, end state and restart. A tool returning successfully only proves that the automation command ran. If an action produces no change, check focus, readiness and input timing before diagnosing gameplay or Engine code. Preserve the evidence for any remaining failure and avoid repeating the same ineffective probe.

Use the project's existing typecheck and public validation tools. Retain successful results while their inputs remain unchanged. If a verification dependency or gameplay hook is absent, report the exact missing prerequisite and hand it to its owner; do not assemble a temporary server, borrow global browser dependencies or simulate missing integration to claim acceptance. A reusable-tool failure can justify a focused diagnostic, but that diagnostic is not normal game acceptance.
`;
