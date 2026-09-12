// Product-owned guidance is bundled into Server and installed with project skills.
export const STUDIO_GAME_AUTHORING_SKILL = `---
name: forgeax-studio-game-authoring
description: Implement a ForgeaX Studio game loop or HUD in the active project, choose focused Engine contracts, and verify a first playable checkpoint before completing presentation and audio.
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

## Common gameplay contracts

For the Studio Game3D template, keep the exported Plugin and its injected world/gameHost. The host loads forge.json.defaultScene before apply(ctx). Extend the existing scene and systems; do not create a second App or World. Copy the current entry's input and cleanup pattern instead of rediscovering it across Engine internals.

The current public ECS resource API is insertResource(key, value), getResource<T>(key), hasResource(key), removeResource(key). insertResource inserts or overwrites and returns void; getResource throws for a missing key. Ordinary shared score/timer state can be a resource; it does not require a managed shared reference. Use a game-specific key and remove it with the plugin's other cleanup.

\`\`\`ts
import { FixedTime, FixedUpdate, type World } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';

export function installRound(world: World): () => void {
  const key = 'bubble-range.round';
  world.insertResource(key, { score: 0, remaining: 60 });
  world.addSystem(FixedUpdate, {
    name: 'bubble-range.round', queries: [],
    fn: () => {
      const round = world.getResource<{ score: number; remaining: number }>(key);
      const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      round.remaining = Math.max(0, round.remaining - world.getResource(FixedTime).delta);
      if (input.keyboard.justPressedCode('KeyR')) {
        round.score = 0;
        round.remaining = 60;
      }
    },
  }).unwrap();
  return () => {
    world.removeSystem(FixedUpdate, 'bubble-range.round').unwrap();
    world.removeResource(key);
  };
}
\`\`\`

Register the returned cleanup through the existing Plugin ctx.effect lifecycle. This is a state/timer example, not a complete game: connect movement, hit scoring and visible feedback in the existing entry before the first Play. Keyboard held input uses input.keyboard.downCode('KeyA'); physics movement belongs in FixedUpdate with FixedTime, visual updates use the entry's Update/Time pattern. Preserve the entry's component leases and authored entity lookup.

Use these names with the installed Engine public facade. If typecheck reports a changed signature, inspect that one public declaration and adapt; do not search the whole Engine for speculative alternative names. For example, a missing resource is a state initialization error, not evidence that setResource/addResource needs discovering.

For HUD work, the main implementation owner translates the designer's state, layout and interaction specification into the project's UI asset and bindings. Do not send HTML/CSS implementation back to a design-only role. Engine UI is not an unrestricted browser document: use the current authoring schema and supported elements/styles, not assumptions from ordinary web frameworks. Use the existing authoring operation's structured diagnostics to fix the affected asset; do not build a separate DOM validator or inspect renderer internals to guess support.

Agree on shared state/event names and output files in the first specialist handoff. Continue independent gameplay work while assets are prepared. A first Play checkpoint needs input, one core rule, visible feedback and restart; it need not wait for all presentation assets. Final delivery still requires the requested presentation, integrated audio and a real game interaction loop.

Use the project's existing typecheck and public validation tools. Retain successful results while their inputs remain unchanged. If a verification dependency or gameplay hook is absent, report the exact missing prerequisite and hand it to its owner; do not assemble a temporary server, borrow global browser dependencies or simulate missing integration to claim acceptance. A reusable-tool failure can justify a focused diagnostic, but that diagnostic is not normal game acceptance.
`;
