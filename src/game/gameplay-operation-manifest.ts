/**
 * Public index for the typed gameplay surface.
 *
 * The managed Studio editor viewport is the only live gameplay surface.
 * Operations carry the scope and are checked against ready identity before
 * dispatch. This manifest is descriptive; it does not create a second World,
 * renderer, or `/preview/` runtime.
 */
import {
  GAMEPLAY_CONTRACT_VERSION,
  GAMEPLAY_OPERATIONS,
  GAMEPLAY_PROVENANCE_FIELDS,
  type GameplayOperationName,
} from "./gameplay-operation-contract";

export type GameplayOperationManifest = {
  version: typeof GAMEPLAY_CONTRACT_VERSION;
  contract: {
    version: typeof GAMEPLAY_CONTRACT_VERSION;
    operations: readonly GameplayOperationName[];
  };
  operations: readonly GameplayOperationName[];
  carrierLifecycle: readonly ["ensure", "status", "reveal", "stop"];
  requiresReadyIdentity: true;
  provenance: typeof GAMEPLAY_PROVENANCE_FIELDS;
  gameplayStopIsDistinctFromCarrierStop: true;
};

export const GAMEPLAY_OPERATION_MANIFEST: GameplayOperationManifest = {
  version: GAMEPLAY_CONTRACT_VERSION,
  contract: { version: GAMEPLAY_CONTRACT_VERSION, operations: GAMEPLAY_OPERATIONS },
  operations: GAMEPLAY_OPERATIONS,
  carrierLifecycle: ["ensure", "status", "reveal", "stop"],
  requiresReadyIdentity: true,
  provenance: GAMEPLAY_PROVENANCE_FIELDS,
  gameplayStopIsDistinctFromCarrierStop: true,
};
