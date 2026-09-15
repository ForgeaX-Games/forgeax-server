// Product-owned guidance is bundled into Server and installed with project skills.
export const STUDIO_GAME_AUTHORING_SKILL = `---
name: forgeax-studio-game-authoring
description: Studio hosted-game tools and runtime contracts. Use when editing a game, discovering asset or Editor capabilities, diagnosing runtime failures, or reporting observed behavior.
---

# Studio game authoring

The active game's \`forge.json\`, declared entry and dependencies identify its hosted runtime. The kernel chooses design, implementation, tool use and collaboration from the user's request.

| Current change | Read or use | Smallest useful proof |
| --- | --- | --- |
| Input, frame time, app lifecycle | [Engine app](../forgeax-engine-app/SKILL.md), then the existing project's input and update system | An actual key or pointer input changes gameplay in Play |
| Gameplay state and rules | [Engine ECS](../forgeax-engine-ecs/SKILL.md); [state](../forgeax-engine-state/SKILL.md) only when needed | Observed behavior matches the requested interaction |
| Scene, asset identity, references | [Engine assets](../forgeax-engine-assets/SKILL.md) and existing project asset entries | Authored scene and referenced assets appear in Play |
| HUD implementation | Discover the current editor UI authoring operation and read its schema; follow the project's declared Engine UI public types | Submit the UI through its authoring validation, then mount and update it from gameplay |
| Audio preparation and integration | The available BGM extension's \`forgeax-game-audio\` skill and \`verify-audio-project\` tool | Preparation, integration and real playback evidence are distinct |
| A concrete runtime failure | [Engine debug](../forgeax-engine-debug/SKILL.md), scoped to the observed error | Repeat the failing player action after the repair |

## Studio host boundary

The installed forgeax-studio-asset-library skill documents asset search, source acquisition and the existing Editor import path. Search results are source candidates, not imported or Play-verified assets.


The active Studio game exports a Plugin; the host already owns App, World and platform backends. Engine skills may also describe building a standalone host with createApp. Those standalone bootstrap examples are not prerequisites for editing this hosted game.

The BGM extension exposes audio preparation and validation tools. Its generated runtime provides public exports and event IDs for gameplay integration; the hosted App owns platform backends. Availability and permissions are defined by the installed tool contracts.

Every external GUID referenced by any returned asset or read through AssetReader must be declared in externalAssets; definitions inside the same pack are not external dependencies. This declaration must equal the actual dependency closure: when removing scene entities, also remove externalAssets entries no longer referenced by any output or AssetReader read. Preserve shared references still used by other outputs. If the pack still returns the starter scene alongside a new scene, validate the dependencies of both outputs. Read the asset compiler diagnostics before switching forge.json.defaultScene. A scene missing from the runtime catalog can be a rejected pack: repair the reported missing or unused declarations rather than repeatedly retrying Play or changing the renderer. Calling the pack build() function or passing TypeScript alone does not validate this closure; confirm the asset compiler accepts the complete pack before reporting it ready.

## Scene visibility

When replacing a starter scene, preserve or deliberately replace its camera and lighting as well as geometry. Lit materials need effective scene lighting; zero lights can render black without a fatal error. For intentionally unlit scenes, use the supported unlit material path instead. Register added light components in sceneComponents and declare any environment asset dependencies. Verify the player, play area and relevant objects are visible from the gameplay camera in both Edit and Play.

Keep tests for these rendering prerequisites when rewriting scene tests. If the design changes (for example to unlit materials), replace the assertion with an equivalent check for that design; do not remove it merely to make the new scene pass.

## Common gameplay contracts

For the Studio Game3D template, keep the exported Plugin and its injected world/gameHost. The host loads forge.json.defaultScene before apply(ctx). Creating a second App or World does not modify the hosted runtime. The entry exposes the supported input and cleanup lifecycle.

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

Register the returned cleanup through the existing Plugin ctx.effect lifecycle. This example illustrates resource lifetime only; it does not prescribe game rules. Keyboard held input uses input.keyboard.downCode('KeyA'); physics movement belongs in FixedUpdate with FixedTime, visual updates use the entry's Update/Time pattern. Preserve the entry's component leases and authored entity lookup.

One-shot input edges such as fire or restart belong to the render-frame input snapshot. If gameplay runs in FixedUpdate, capture these edges once in an Update system after the input scan and before FixedUpdate, then consume the queued command once in FixedUpdate. Do not read justPressedCode directly on every fixed tick: a frame with no fixed tick loses the edge, while catch-up ticks can repeat it. Continuous movement can read the held-key state.

Use these names with the installed Engine public facade. If typecheck reports a changed signature, inspect that one public declaration and adapt; do not search the whole Engine for speculative alternative names. For example, a missing resource is a state initialization error, not evidence that setResource/addResource needs discovering.

Engine UI supports the elements/styles in the discovered authoring schema, rather than every browser DOM feature. Authoring operations return structured validation diagnostics. Audio runtime exports and event IDs are defined by the generated public declarations. Scene validation establishes asset validity, not gameplay semantics.

## Imported model placement

When using imported 3D models, load forgeax-studio-asset-library before
binding mesh GUIDs. Preserve the complete model's node transforms and hierarchy, and fit
its assembled bounds to gameplay dimensions. Raw mesh coordinates alone do not describe
the imported model's orientation or size. Validate scene visibility after placement as
well as the requested behavior; import success and runtime updates do not establish
visible assets. These checks do not require 3D assets or add features to other game types.

## Player interaction verification

The Editor transport exposes discover, run.dispatch and gameplay describe/input/query/capture. Discovery supplies supported operations and their prerequisites. A run that is accepted or still running has not succeeded. Transport success does not imply producer success: nested result.ok, errors and terminal operation status describe the actual result. Entity/component handles belong to one Play world.

Successful current-run input/query/capture results can include verificationEvidence.id. deliver_summary checks these exact IDs against the session, game, runtime and authored inputs. Reports describe observed user-requested behavior; the host does not certify gameplay semantics from receipts. Input and a later observation establish interaction evidence. End states, scores and restart checks apply when required by the game request, not to every game. Missing or rejected evidence remains failed/unverified.

An editor-carrier-ambiguous/unavailable or entering-play failure is a Studio transport/lifecycle prerequisite, not proof that gameplay code is wrong. Use the returned recovery action only when its prerequisite changed; otherwise preserve the failure and report the exact blocker. Do not retry identical calls, patch unrelated game code, or claim the game is playable. After code or asset edits, new Play attempts, failures, or server restart, obtain fresh evidence. These receipts establish observations, not the truth of a model's semantic claim: compare the visible outcome with the user's requirements before delivery.


Enter Play through the normal Studio UI, wait for the game HUD or scene to be ready, and focus the game canvas before keyboard input. Keep key-down active across game frames before key-up; a human-scale tap (for example 100-200 ms) avoids missing an input sampled between frames. Release held keys even if the check fails.

Use the browser tool's advertised schema and execution API. In Playwright, keyboard belongs to page.keyboard; target the game frame for its canvas and HUD, and use page.waitForTimeout when a short input hold is needed. Do not substitute synthetic DOM events or mutate game state to claim a player action succeeded.

Observe the game frame rather than repeatedly snapshotting the full Studio page and its chat history. Use a targeted accessibility snapshot or visible HUD locators for the values being checked; expand to the surrounding Studio UI only when navigation or an error requires it. A canvas or shadow-root HUD may be absent from body.innerText, so empty document text is not proof that the game has no UI.

Gameplay acceptance is relative to the user request; receipts do not authorize changing explicit rules, options or limits. Inspect actual rendered frames during movement and after releasing input: the requested camera perspective must remain usable, the player and threats must stay readable, and template showcase props must not obscure the game. A changing HUD, accepted key events, or a victory dialog alone does not prove visible movement or playable presentation.

Compare observable results for the requested behavior before and after input. A tool returning successfully only proves that the automation command ran. If an action produces no change, check focus, readiness and input timing before diagnosing gameplay or Engine code. Preserve the evidence for any remaining failure and avoid repeating the same ineffective probe.

Inspect the rendered game frame and relevant renderer/asset warnings after a scene change. A zero-light warning with lit materials or a black play area is a failed visual check even when Play starts and the HUD updates. Repair the scene and repeat the affected visual check before claiming completion. If frame capture is unavailable, report visual acceptance as unverified.

Use the project's existing typecheck and public validation tools. Retain successful results while their inputs remain unchanged. If a verification dependency or gameplay hook is absent, report the exact missing prerequisite and hand it to its owner; do not assemble a temporary server, borrow global browser dependencies or simulate missing integration to claim acceptance. A reusable-tool failure can justify a focused diagnostic, but that diagnostic is not normal game acceptance.
`;
