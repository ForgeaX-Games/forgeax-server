import { describe, expect, test } from "bun:test";
import {
  checkGameplayDependencyGate,
  type W1L1HEvidence,
} from "../src/game/gameplay-dependency-gate";

const completeEvidence: W1L1HEvidence = {
  merged: { sha: "abc123", ci: "studio-ci" },
  identity: true,
  readiness: true,
  heartbeat: true,
  reload: true,
  shutdown: true,
  studio: { server: "18900", ui: "18920", smoke: true },
};

describe("gameplay dependency gate", () => {
  test("closes when any W1-L1H evidence is missing", () => {
    for (const key of ["merged", "identity", "readiness", "heartbeat", "reload", "shutdown", "studio"]) {
      const evidence = { ...completeEvidence, [key]: undefined } as unknown as Partial<W1L1HEvidence>;
      const result = checkGameplayDependencyGate(evidence);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("dependency-gate-closed");
    }
  });

  test("closes when evidence is present but invalid", () => {
    const result = checkGameplayDependencyGate({
      ...completeEvidence,
      merged: { sha: "", ci: "" },
      studio: { server: "15173", ui: "", smoke: false },
    } as unknown as Partial<W1L1HEvidence>);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.phase).toBe("dependency");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("opens only for complete valid evidence", () => {
    expect(checkGameplayDependencyGate(completeEvidence)).toEqual({ ok: true });
  });
});
