import type {
  ExtensionCapabilityControl,
  ExtensionCapabilityInvocationContext,
  ExtensionCapabilityProvider,
} from '@forgeax/types';
import type { EditorTransportCarrier } from './editor-transport-carrier';

/** Versioned host capability used by asset-producing extensions. */
export const EDITOR_ASSET_IMPORT_CAPABILITY = 'editor.asset.import';
export const EDITOR_ASSET_IMPORT_CAPABILITY_VERSION = 1;

const MAX_BASE64_LENGTH = 180 * 1024 * 1024;

type EditorAssetImportInput = {
  readonly base64: string;
  readonly destPath: string;
  readonly sourceName: string;
  readonly requestId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidInput(hint: string): { ok: false; error: Record<string, unknown> } {
  return {
    ok: false,
    error: {
      code: 'editor-asset-import-invalid-input',
      hint,
      retryable: false,
      recoveryActions: ['transport.describe'],
    },
  };
}

function parseInput(value: unknown): EditorAssetImportInput | null {
  if (!isRecord(value)) return null;
  const base64 = value.base64;
  const destPath = value.destPath;
  const sourceName = value.sourceName;
  const requestId = value.requestId;
  if (
    typeof base64 !== 'string' || base64.trim() === '' || base64.length > MAX_BASE64_LENGTH
    || typeof destPath !== 'string' || destPath.trim() === ''
    || typeof sourceName !== 'string' || sourceName.trim() === ''
    || typeof requestId !== 'string' || requestId.trim() === ''
  ) return null;
  return { base64, destPath: destPath.trim(), sourceName: sourceName.trim(), requestId: requestId.trim() };
}

function actorFor(context: ExtensionCapabilityInvocationContext): { id: string; kind: 'human' | 'ai' } {
  const caller = context.caller;
  const id = caller.agentId ?? caller.sessionId ?? caller.threadId ?? `extension:${context.toolId}`;
  return { id, kind: caller.kind === 'ai' ? 'ai' : 'human' };
}

function sessionFor(context: ExtensionCapabilityInvocationContext): string {
  return context.caller.sessionId
    ?? context.caller.threadId
    ?? `extension:${context.toolId}`;
}

export function createEditorAssetImportProvider(
  dispatch: EditorTransportCarrier['dispatch'],
): ExtensionCapabilityProvider {
  return {
    capabilityId: EDITOR_ASSET_IMPORT_CAPABILITY,
    version: EDITOR_ASSET_IMPORT_CAPABILITY_VERSION,
    async invoke(rawInput, _options, context) {
      const input = parseInput(rawInput);
      if (input === null) return invalidInput(`Expected base64 source bytes (at most ${MAX_BASE64_LENGTH} characters), destPath, sourceName, and requestId.`);
      if (!context.game) {
        return {
          ok: false,
          error: {
            code: 'editor-asset-import-game-missing',
            hint: 'No game scope is bound to this extension call. Open a Studio game before importing the generated asset.',
            retryable: true,
            recoveryActions: ['scope.select', 'request.retry'],
          },
        };
      }

      const id = `asset-import:${context.game}:${input.requestId}`;
      const response = await dispatch({
        jsonrpc: '2.0',
        version: 'editor-transport/v1',
        id,
        correlationId: id,
        scope: `game:${context.game}`,
        method: 'asset.importSource',
        timeoutMs: 300_000,
        params: {
          input,
          actor: actorFor(context),
          sessionId: sessionFor(context),
          permission: 'execute',
        },
      });
      if (response.error !== undefined) return { ok: false, error: response.error };
      return { ok: true, result: response.result };
    },
  };
}

export function registerEditorAssetImportCapability(
  control: ExtensionCapabilityControl,
  dispatch: EditorTransportCarrier['dispatch'],
): void {
  control.registerProvider(createEditorAssetImportProvider(dispatch));
}
