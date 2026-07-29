import type { GameplayProvenance } from './gameplay-operation-contract';

export type GameplayCaptureArtifact = { dataUrl: string; bytes: number; provenance: GameplayProvenance };
export type GameplayCaptureSurface = {
  produce: () => Promise<{ dataUrl: string; bytes: number }>;
  focus: () => Promise<void>;
};

function isCaptureArtifact(value: unknown): value is GameplayCaptureArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<GameplayCaptureArtifact>;
  return typeof artifact.dataUrl === 'string'
    && typeof artifact.bytes === 'number'
    && !!artifact.provenance
    && typeof artifact.provenance === 'object';
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
            code: 'operation-failed' as const,
            phase: 'reveal' as const,
            retryable: false,
            message: 'Capture artifact is malformed or missing provenance.',
            hint: { action: 'capture-again' as const },
            identity: current,
            detail: { code: 'invalid-capture-artifact' },
          },
        };
      }
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(current)) return { ok: false as const, error: { code: 'identity-mismatch', phase: 'reveal' as const, retryable: false, message: 'Capture provenance is stale or belongs to another carrier.', hint: { action: 'capture-again' as const }, identity: current } };
      await surface.focus();
      return { ok: true as const };
    },
  };
}
