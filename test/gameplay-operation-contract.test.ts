import { describe, expect, test } from "bun:test";
import {
  GAMEPLAY_OPERATIONS,
  parseGameplayOperation,
  type GameplayError,
  type GameplayOperation,
  type GameplayProvenance,
  type GameplayResult,
} from "../src/game/gameplay-operation-contract";
import { GAMEPLAY_INPUT_SCHEMA, gameplayHostTool } from "../src/game/host-tools";

describe("gameplay operation contract", () => {
  test("enumerates the six typed gameplay operations", () => {
    expect(GAMEPLAY_OPERATIONS).toEqual([
      "play",
      "gameplayStop",
      "input",
      "query",
      "capture",
      "reveal",
    ]);
  });

  test("publishes the typed operation union through the host-tool schema", () => {
    const schema = GAMEPLAY_INPUT_SCHEMA as unknown as { oneOf: ReadonlyArray<{ properties?: { operation?: { const?: string } } }> };
    expect(schema.oneOf.map((entry) => entry.properties?.operation?.const)).toEqual([
      "play",
      "gameplayStop",
      "capture",
      "input",
      "query",
      "reveal",
    ]);
    expect((gameplayHostTool().inputSchema as { oneOf?: unknown[] }).oneOf).toHaveLength(6);
  });

  test("rejects an unknown operation before dispatch", () => {
    expect(() => parseGameplayOperation({ operation: "eval", scope: {} })).toThrow(
      /unknown operation/,
    );
  });

  test("rejects malformed payloads before dispatch", () => {
    expect(() => parseGameplayOperation({ operation: "play" })).toThrow(
      /scope/,
    );
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" } })).toThrow(
      /input action/,
    );
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" }, action: { type: "mouse" } })).toThrow(/input action/);
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" }, action: { type: "key", key: "", phase: "down" } })).toThrow(/input action/);
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" }, action: { type: "key", key: "A", phase: "hold" } })).toThrow(/input action/);
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" }, action: { type: "pointer", x: Number.NaN, y: 1 } })).toThrow(/input action/);
    expect(() => parseGameplayOperation({ operation: "input", scope: { projectId: "p", gameId: "g" }, action: { type: "pointer", x: 1, y: 1, button: "back" } })).toThrow(/input action/);
  });

  test("keeps result, error, and provenance fields machine-readable", () => {
    const provenance: GameplayProvenance = {
      runtimeId: "runtime-1",
      scope: { projectId: "project-1", gameId: "game-1" },
      pageIdentity: "page-1",
      canvasIdentity: "canvas-1",
      rendererGeneration: 3,
    };
    const result: GameplayResult = {
      ok: true,
      operation: "play",
      state: "running",
      identity: provenance,
    };
    const error: GameplayError = {
      code: "readiness-pending",
      phase: "ready",
      retryable: true,
      message: "The live surface is not ready.",
      hint: { action: "wait" },
      identity: provenance,
      readiness: "pending",
    };

    expect(result.identity.rendererGeneration).toBe(3);
    expect(error.hint.action).toBe("wait");
  });

  test("accepts each known operation as a typed request", () => {
    const requests: GameplayOperation[] = [
      { operation: "play", scope: { projectId: "p", gameId: "g" } },
      { operation: "gameplayStop", scope: { projectId: "p", gameId: "g" } },
      {
        operation: "input",
        scope: { projectId: "p", gameId: "g" },
        action: { type: "key", key: "ArrowLeft", phase: "down" },
      },
      { operation: "query", scope: { projectId: "p", gameId: "g" }, query: "player" },
      { operation: "capture", scope: { projectId: "p", gameId: "g" } },
      { operation: "reveal", scope: { projectId: "p", gameId: "g" }, artifact: { dataUrl: "data:image/png;base64,frame", bytes: 27, provenance: { runtimeId: "runtime-1", scope: { projectId: "p", gameId: "g" }, pageIdentity: "page-1", canvasIdentity: "canvas-1", rendererGeneration: 1 } } },
    ];

    expect(requests.map((request) => parseGameplayOperation(request).operation)).toEqual(
      [...GAMEPLAY_OPERATIONS],
    );
  });
});
