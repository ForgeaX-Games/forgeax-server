# Managed gameplay operations

The gameplay operation contract is the discoverable, typed entry point for
Forge actions against the existing managed Studio carrier:

`Play → input → query → capture → reveal`

The server owns the operation schema, current carrier readiness check, and
provenance comparison. Release composition is validated outside the request
path. The live Editor Gateway owns dispatch to the World that
already renders in the real `:18920` Studio page. No operation creates a second
World, renderer, browser page, or fallback `:15173` surface.

The W1 carrier page is the Studio root with its in-process editor viewport. The
separate `/preview/` runtime is not the gameplay surface for this contract.

## Operations

`GAMEPLAY_OPERATION_MANIFEST` is the index. Its operations are:

- `play`: start gameplay in the current carrier.
- `gameplayStop`: stop gameplay while preserving the carrier and its legacy UI.
- `input`: send a typed key or pointer action to the current World.
- `query`: read typed gameplay state from that World.
- `capture`: produce a readable frame artifact with runtime, scope, page, canvas,
  and renderer-generation provenance.
- `reveal`: focus the same live carrier after validating the artifact provenance.

Minimal request examples:

```ts
parseGameplayOperation({
  operation: "play",
  scope: { projectId: "project-1", gameId: "game-1" },
});

parseGameplayOperation({
  operation: "input",
  scope: { projectId: "project-1", gameId: "game-1" },
  action: { type: "key", key: "ArrowRight", phase: "down" },
});
```

Unknown operations, including arbitrary `eval`, fail before dispatch. A
pending, stale, unavailable, or mismatched carrier returns a machine-readable
error with a recovery hint; callers must not silently switch carriers.

## Stop and recovery boundaries

`gameplayStop` is an in-game transition. Carrier `stop` is lifecycle teardown.
The latter is reserved for the managed host and must not be used as a gameplay
fallback. A stale or tampered capture is rejected before focus or reveal, so a
failed reveal leaves the current World and carrier intact.

Release evidence is a build and CI concern, not a gameplay request-time
boolean. Each request checks the current carrier identity, readiness, liveness,
and producer result before returning success.
