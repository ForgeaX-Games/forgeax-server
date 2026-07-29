/**
 * Public index for the typed gameplay surface.
 *
 * The managed Studio editor viewport is the only live gameplay surface.
 * Operations carry the scope and are checked against ready identity before
 * dispatch. This manifest is descriptive; it does not create a second World,
 * renderer, or `/preview/` runtime.
 */
import { GAMEPLAY_OPERATIONS, type GameplayOperationName } from "./gameplay-operation-contract";

export type GameplayOperationManifest = {
  operations: readonly GameplayOperationName[];
  carrierLifecycle: readonly ["ensure", "status", "reveal", "stop"];
  dependencyGate: "W1-L1H";
  requiresReadyIdentity: true;
  provenance: readonly ["runtimeId", "scope", "pageIdentity", "canvasIdentity", "rendererGeneration"];
  gameplayStopIsDistinctFromCarrierStop: true;
};

export const GAMEPLAY_OPERATION_MANIFEST: GameplayOperationManifest = {
  operations: GAMEPLAY_OPERATIONS,
  carrierLifecycle: ["ensure", "status", "reveal", "stop"],
  dependencyGate: "W1-L1H",
  requiresReadyIdentity: true,
  provenance: ["runtimeId", "scope", "pageIdentity", "canvasIdentity", "rendererGeneration"],
  gameplayStopIsDistinctFromCarrierStop: true,
};
