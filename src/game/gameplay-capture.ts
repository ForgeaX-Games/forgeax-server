import { isGameplayProvenance, sameGameplayIdentity, type GameplayProvenance } from './gameplay-operation-contract';

export type GameplayCaptureArtifact = { dataUrl: string; bytes: number; provenance: GameplayProvenance };
export type GameplayCaptureSurface = {
  produce: () => Promise<{ dataUrl: string; bytes: number }>;
  focus: () => Promise<void>;
};

function isCaptureArtifact(value: unknown): value is GameplayCaptureArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<GameplayCaptureArtifact>;
  return typeof artifact.dataUrl === 'string'
    && artifact.dataUrl.length > 0
    && typeof artifact.bytes === 'number'
    && Number.isInteger(artifact.bytes)
    && artifact.bytes > 0
    && !!artifact.provenance
    && isGameplayProvenance(artifact.provenance);
}

export function validateGameplayCaptureArtifact(value: unknown, current?: GameplayProvenance) {
  if (!isCaptureArtifact(value)) {
    return {
      ok: false as const,
      error: {
        owner: 'contract' as const,
        code: 'invalid-capture-artifact' as const,
        phase: 'capture' as const,
        retryable: false,
        message: 'Capture artifact is malformed or blank.',
        hint: { action: 'capture-again' as const },
        ...(current ? { identity: current } : {}),
      },
    };
  }
  if (current) {
    const match = sameGameplayIdentity(current, value.provenance);
    if (!match.matches) {
      return {
        ok: false as const,
        error: {
          owner: 'contract' as const,
          code: 'identity-mismatch' as const,
          phase: 'reveal' as const,
          retryable: false,
          message: 'Capture provenance does not match the current carrier identity.',
          hint: { action: 'capture-again' as const },
          identity: current,
          details: { mismatches: match.mismatches },
        },
      };
    }
  }
  return { ok: true as const, artifact: value };
}

export function createGameplayCapture(surface: GameplayCaptureSurface) {
  return {
    async produce(provenance: GameplayProvenance): Promise<GameplayCaptureArtifact> {
      const frame = await surface.produce();
      if (!frame.dataUrl || frame.bytes <= 0) throw new Error('live canvas produced no readable artifact');
      return { ...frame, provenance };
    },
    async reveal(artifact: unknown, current: GameplayProvenance) {
      if (!isCaptureArtifact(artifact)) {
        return {
          ok: false as const,
          error: {
            owner: 'contract' as const,
            code: 'operation-failed' as const,
            phase: 'reveal' as const,
            retryable: false,
            message: 'Capture artifact is malformed or missing provenance.',
            hint: { action: 'capture-again' as const },
            identity: current,
            details: { code: 'invalid-capture-artifact' },
          },
        };
      }
      const match = sameGameplayIdentity(current, artifact.provenance);
      if (!match.matches) return { ok: false as const, error: { owner: 'contract' as const, code: 'identity-mismatch', phase: 'reveal' as const, retryable: false, message: 'Capture provenance is stale or belongs to another carrier.', hint: { action: 'capture-again' as const }, identity: current, details: { mismatches: match.mismatches } } };
      await surface.focus();
      return { ok: true as const };
    },
  };
}
