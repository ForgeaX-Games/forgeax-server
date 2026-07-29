/** Typed, discoverable operations for the managed :18900 → :18920 carrier. */
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
  | "dependency-gate-closed"
  | "scope-conflict"
  | "unknown-runtime"
  | "readiness-pending"
  | "health-stale"
  | "surface-unavailable"
  | "identity-mismatch"
  | "operation-unsupported"
  | "operation-failed";
export type GameplayPhase = "dependency" | "ensure" | "ready" | "dispatch" | "capture" | "reveal";
export type GameplayHint =
  | { action: "wait" }
  | { action: "status" }
  | { action: "ensure"; scope: GameplayScope }
  | { action: "capture-again" };

export type GameplayResult = {
  ok: true;
  operation: GameplayOperationName;
  state: GameplayState;
  identity: GameplayProvenance;
  data?: unknown;
};

export type GameplayError = {
  code: GameplayErrorCode;
  phase: GameplayPhase;
  retryable: boolean;
  message: string;
  hint: GameplayHint;
  identity?: GameplayProvenance;
  readiness?: GameplayReadiness;
  /** Producer error retained for machine diagnostics without widening the public code union. */
  detail?: unknown;
};

export type GameplayFailure = { ok: false; error: GameplayError };
export type GameplayResponse = GameplayResult | GameplayFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

export function parseGameplayOperation(value: unknown): GameplayOperation {
  if (!isRecord(value) || typeof value.operation !== "string") throw new Error("invalid operation payload");
  if (!GAMEPLAY_OPERATIONS.includes(value.operation as GameplayOperationName)) throw new Error("unknown operation");
  assertScope(value.scope);
  if (value.operation === "input") {
    if (!isGameplayInputAction(value.action)) throw new Error("invalid input action");
  }
  if (value.operation === "query" && typeof value.query !== "string") throw new Error("invalid query");
  return value as GameplayOperation;
}
