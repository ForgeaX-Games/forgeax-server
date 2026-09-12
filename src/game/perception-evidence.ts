import type { HostToolRunCtx } from '@forgeax/orchestrator/seams';

const recovery = 'Open the active game in Studio and enter Play, then use editor_transport discover to check the connected page capabilities. Retry only after availability changes. Missing evidence leaves gameplay unverified; RHI captureFrame is a separate debug recorder, not a normal screenshot.';

function unavailable(kind: 'world' | 'frame', reason: unknown) {
  return {
    ok: false, unavailable: true, evidenceStatus: 'unverified',
    error: {
      code: 'perception-evidence-unavailable',
      operation: kind === 'world' ? 'query_world' : 'capture_frame',
      reason: typeof reason === 'string' ? reason : 'invalid perception response',
      hint: recovery,
      retryable: false,
    },
  };
}

/** These tools request evidence, not capability discovery. A completed RPC
 * without a usable observation must reach both host bridges as a tool error. */
export async function readPerceptionEvidence(kind: 'world' | 'frame', ctx: HostToolRunCtx, query?: unknown) {
  if (!ctx.perception) return unavailable(kind, 'no perception channel');
  let value: unknown;
  try {
    value = await ctx.perception(kind, query);
  } catch (error) {
    return unavailable(kind, error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable(kind, 'empty perception response');
  const snap = value as Record<string, unknown>;
  if (snap.unavailable === true || snap.ok === false || snap.error !== undefined) {
    return unavailable(kind, snap.reason ?? (typeof snap.error === 'string' ? snap.error : JSON.stringify(snap.error)));
  }
  if (kind === 'world') {
    if (!Number.isInteger(snap.entityCount) || (snap.entityCount as number) < 0 || !Array.isArray(snap.archetypes)) {
      return unavailable(kind, 'missing live ECS snapshot');
    }
    return { ...snap, ok: true, evidenceStatus: 'observed', evidenceKind: 'world-snapshot', gameplayVerified: false };
  }
  const dataUrl = snap.dataUrl;
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    return unavailable(kind, 'missing or invalid PNG frame');
  }
  const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (!completePng(png)) {
    return unavailable(kind, 'invalid PNG frame');
  }
  // Preserve the complete image. The old 64-character prefix was not viewable
  // evidence, and counting that URL's characters did not measure PNG bytes.
  return { ok: true, evidenceStatus: 'observed', evidenceKind: 'frame', gameplayVerified: false, bytes: png.length, dataUrl };
}

/** Reject prefix-only or truncated captures before labelling them evidence. */
function completePng(png: Buffer): boolean {
  if (png.length < 45 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let imageData = false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > png.length) return false;
    if (offset === 8 && (type !== 'IHDR' || length !== 13 || png.readUInt32BE(offset + 8) === 0 || png.readUInt32BE(offset + 12) === 0)) return false;
    if (type === 'IDAT' && length > 0) imageData = true;
    if (type === 'IEND') return imageData && length === 0 && next === png.length;
    offset = next;
  }
  return false;
}
