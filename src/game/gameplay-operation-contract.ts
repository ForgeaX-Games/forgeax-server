/** Editor-owned v1 gameplay contract projected into the Server application service. */
export const GAMEPLAY_CONTRACT_VERSION = 1 as const;
export const GAMEPLAY_BRIDGE_VERSION = GAMEPLAY_CONTRACT_VERSION;

export const GAMEPLAY_OPERATIONS = [
  "play",
  "gameplayStop",
  "input",
  "query",
  "capture",
  "reveal",
] as const;

export type GameplayOperationName = (typeof GAMEPLAY_OPERATIONS)[number];
export type GameplayScope = { projectId: string; gameId: string };
export const GAMEPLAY_PROVENANCE_FIELDS = [
  "runtimeId",
  "scope",
  "pageIdentity",
  "canvasIdentity",
  "rendererGeneration",
] as const;

export type GameplayInputAction =
  | { type: "key"; key: string; phase: "down" | "up" }
  | { type: "pointer"; x: number; y: number; button?: "left" | "middle" | "right" };

export type GameplayOperation =
  | { operation: "play" | "gameplayStop" | "capture"; scope: GameplayScope }
  | { operation: "reveal"; scope: GameplayScope; artifact: unknown }
  | { operation: "input"; scope: GameplayScope; action: GameplayInputAction }
  | { operation: "query"; scope: GameplayScope; query: string };

/**
 * `gameplayStop` stops gameplay in the existing carrier. It is not the
 * carrier lifecycle `stop`, which tears down the managed host.
 * Capture artifacts are revealed only after their full provenance matches.
 */

export type GameplayProvenance = {
  runtimeId: string;
  scope: GameplayScope;
  pageIdentity: string;
  canvasIdentity: string;
  rendererGeneration: number;
};

export type GameplayState = "running" | "stopped";
export type GameplayReadiness = "pending" | "ready" | "stale" | "unavailable";
export type GameplayErrorCode =
  | "scope-conflict"
  | "unknown-runtime"
  | "readiness-pending"
  | "health-stale"
  | "surface-unavailable"
  | "identity-mismatch"
  | "operation-unsupported"
  | "operation-failed"
  | "readiness-timeout"
  | "operation-aborted"
  | "invalid-capture-artifact"
  | (string & {});
export type GameplayPhase = "dependency" | "ensure" | "ready" | "dispatch" | "capture" | "reveal";
export type GameplayErrorOwner = "contract" | "application" | "carrier" | "producer" | "transport" | (string & {});
export type GameplayHint =
  | { action: "wait" }
  | { action: "status" }
  | { action: "ensure"; scope: GameplayScope }
  | { action: "capture-again" };

export type GameplayBridgeRequest = {
  version: typeof GAMEPLAY_BRIDGE_VERSION;
  operation: GameplayOperation;
  identity: GameplayProvenance;
};

export type GameplayResult = {
  ok: true;
  operation: GameplayOperationName;
  state: GameplayState;
  identity: GameplayProvenance;
  data?: unknown;
};

export type GameplayError = {
  owner: GameplayErrorOwner;
  code: GameplayErrorCode;
  phase: GameplayPhase;
  retryable: boolean;
  message: string;
  hint: GameplayHint;
  identity?: GameplayProvenance;
  readiness?: GameplayReadiness;
  /** Producer-owned diagnostics remain opaque to the application service. */
  details?: unknown;
};

export type GameplayFailure = { ok: false; error: GameplayError };
export type GameplayResponse = GameplayResult | GameplayFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`unexpected field: ${extra}`);
}

function isGameplayInputAction(value: unknown): value is GameplayInputAction {
  if (!isRecord(value) || (value.type !== "key" && value.type !== "pointer")) return false;
  if (value.type === "key") {
    return typeof value.key === "string"
      && value.key.trim().length > 0
      && (value.phase === "down" || value.phase === "up");
  }
  return Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && (value.button === undefined || value.button === "left" || value.button === "middle" || value.button === "right");
}

function assertScope(value: unknown): asserts value is GameplayScope {
  if (!isRecord(value) || typeof value.projectId !== "string" || !value.projectId || typeof value.gameId !== "string" || !value.gameId) {
    throw new Error("invalid scope");
  }
}

function assertProvenance(value: unknown): asserts value is GameplayProvenance {
  if (!isRecord(value)) throw new Error("invalid identity");
  if (typeof value.runtimeId !== "string" || value.runtimeId.length === 0) throw new Error("invalid identity runtimeId");
  assertScope(value.scope);
  if (typeof value.pageIdentity !== "string" || value.pageIdentity.length === 0) throw new Error("invalid identity pageIdentity");
  if (typeof value.canvasIdentity !== "string" || value.canvasIdentity.length === 0) throw new Error("invalid identity canvasIdentity");
  if (typeof value.rendererGeneration !== "number" || !Number.isInteger(value.rendererGeneration) || value.rendererGeneration < 0) throw new Error("invalid identity rendererGeneration");
  assertOnlyKeys(value, GAMEPLAY_PROVENANCE_FIELDS);
}

export function isGameplayProvenance(value: unknown): value is GameplayProvenance {
  try {
    assertProvenance(value);
    return true;
  } catch {
    return false;
  }
}

export function parseGameplayOperation(value: unknown): GameplayOperation {
  if (!isRecord(value) || typeof value.operation !== "string") throw new Error("invalid operation payload");
  if (!GAMEPLAY_OPERATIONS.includes(value.operation as GameplayOperationName)) throw new Error("unknown operation");
  assertScope(value.scope);
  if (value.operation === "play" || value.operation === "gameplayStop" || value.operation === "capture") {
    assertOnlyKeys(value, ["operation", "scope"]);
  } else if (value.operation === "input") {
    assertOnlyKeys(value, ["operation", "scope", "action"]);
    if (!isGameplayInputAction(value.action)) throw new Error("invalid input action");
  } else if (value.operation === "query") {
    assertOnlyKeys(value, ["operation", "scope", "query"]);
    if (typeof value.query !== "string") throw new Error("invalid query");
  } else {
    assertOnlyKeys(value, ["operation", "scope", "artifact"]);
  }
  return value as GameplayOperation;
}

export function parseGameplayBridgeRequest(value: unknown): GameplayBridgeRequest {
  if (!isRecord(value) || value.version !== GAMEPLAY_BRIDGE_VERSION) throw new Error("unsupported gameplay bridge version");
  assertOnlyKeys(value, ["version", "operation", "identity"]);
  const operation = parseGameplayOperation(value.operation);
  assertProvenance(value.identity);
  if (operation.scope.projectId !== value.identity.scope.projectId || operation.scope.gameId !== value.identity.scope.gameId) {
    throw new Error("operation scope does not match identity scope");
  }
  return { version: GAMEPLAY_BRIDGE_VERSION, operation, identity: value.identity };
}

export type GameplayIdentityField =
  | "runtimeId"
  | "scope.projectId"
  | "scope.gameId"
  | "pageIdentity"
  | "canvasIdentity"
  | "rendererGeneration";

export type GameplayIdentityMatch =
  | { matches: true; mismatches: readonly [] }
  | { matches: false; mismatches: ReadonlyArray<{ field: GameplayIdentityField; expected: unknown; actual: unknown }> };

export function sameGameplayIdentity(expected: GameplayProvenance, actual: GameplayProvenance): GameplayIdentityMatch {
  const values: ReadonlyArray<[GameplayIdentityField, unknown, unknown]> = [
    ["runtimeId", expected.runtimeId, actual.runtimeId],
    ["scope.projectId", expected.scope.projectId, actual.scope.projectId],
    ["scope.gameId", expected.scope.gameId, actual.scope.gameId],
    ["pageIdentity", expected.pageIdentity, actual.pageIdentity],
    ["canvasIdentity", expected.canvasIdentity, actual.canvasIdentity],
    ["rendererGeneration", expected.rendererGeneration, actual.rendererGeneration],
  ];
  const mismatches = values
    .filter(([, left, right]) => left !== right)
    .map(([field, left, right]) => ({ field, expected: left, actual: right }));
  return mismatches.length === 0 ? { matches: true, mismatches: [] } : { matches: false, mismatches };
}
