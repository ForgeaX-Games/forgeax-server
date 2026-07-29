import type { GameplayFailure } from "./gameplay-operation-contract";

export type W1L1HEvidence = {
  merged: { sha: string; ci: string };
  identity: boolean;
  readiness: boolean;
  heartbeat: boolean;
  reload: boolean;
  shutdown: boolean;
  studio: { server: "18900"; ui: "18920"; smoke: boolean };
};

export type GameplayDependencyGateResult = { ok: true } | GameplayFailure;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function checkGameplayDependencyGate(
  evidence: Partial<W1L1HEvidence> | undefined,
): GameplayDependencyGateResult {
  const valid =
    evidence !== undefined &&
    isNonEmptyString(evidence.merged?.sha) &&
    isNonEmptyString(evidence.merged?.ci) &&
    evidence.identity === true &&
    evidence.readiness === true &&
    evidence.heartbeat === true &&
    evidence.reload === true &&
    evidence.shutdown === true &&
    evidence.studio?.server === "18900" &&
    evidence.studio.ui === "18920" &&
    evidence.studio.smoke === true;

  if (!valid) {
    return {
      ok: false,
      error: {
        code: "dependency-gate-closed",
        phase: "dependency",
        retryable: false,
        message: "W1-L1H dependency evidence is incomplete or invalid.",
        hint: { action: "status" },
      },
    };
  }

  return { ok: true };
}
