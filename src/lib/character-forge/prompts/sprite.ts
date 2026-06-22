import type { SpriteAction, SpriteDirection, StylePreset } from '../types';

const ACTION_VERB: Record<SpriteAction, string> = {
  walk: 'walking forward, weight transferring from one foot to the other',
  idle: 'standing breathing in place, micro chest-rise / arm sway',
  attack: 'swinging the equipped weapon (or fist) in a clean arc',
};

const DIR_LABEL: Record<SpriteDirection, string> = {
  down: 'FACING THE CAMERA (FRONT)',
  left: 'FACING LEFT (90° profile, left side of the character visible)',
  right: 'FACING RIGHT (90° profile, right side of the character visible)',
  up: 'FACING AWAY FROM CAMERA (BACK)',
};

export interface SpritePromptInput {
  userDescription: string;
  style: StylePreset;
  action: SpriteAction;
  directions: SpriteDirection[];
  framesPerDir: number;
  /** Optional anchor: a base64-encoded portrait passed as a reference image to
   * the vendor; the prompt text just acknowledges it so the model knows to
   * sample identity from the attachment rather than from text alone. */
  hasReferenceImage: boolean;
}

/**
 * Sprite-sheet prompt — adapted from
 * `3rd/workbench/character-editor/src/pipelines/pixel-char/prompt-engine.ts`
 * (kept simpler: no Spine parts, no monster-vs-human branching, just N-frame
 * walk/idle/attack on a chibi character).  The grid contract is:
 *
 *   rows = directions.length     (one row per facing)
 *   cols = framesPerDir          (one column per frame)
 *
 * Vendor renders the sheet on a transparent background; sprite-cut.ts then
 * slices it client-side into individual frames at panel mount time.
 */
export function buildSpriteSheetPrompt(input: SpritePromptInput): string {
  const cols = input.framesPerDir;
  const rows = input.directions.length;
  const dirCount = rows;
  const dirList = input.directions.map((d) => `  • Row for ${DIR_LABEL[d]}`).join('\n');

  return `
SPRITE SHEET FOR A GAME CHARACTER

CHARACTER:
${input.userDescription.trim()}
${input.hasReferenceImage ? '\n(Use the attached reference image to keep face / outfit / weapon identical to the established portrait.)\n' : ''}

ACTION: ${input.action.toUpperCase()} — ${ACTION_VERB[input.action]}

═══ GRID CONTRACT (ABSOLUTE) ═══
Output ONE image with EXACTLY ${rows} rows × ${cols} columns = ${rows * cols} cells.
Cells are equal-sized squares laid out as a clean grid (zero padding gaps).
Each row corresponds to ONE facing direction; left-to-right reading order shows the animation in time.

ROWS (top → bottom):
${dirList}

═══ FRAME CONTRACT ═══
- Frame 0 (leftmost cell of each row) = the rest / contact pose.
- Frame ${cols - 1} (rightmost cell) = the most extreme pose of the action.
- Intermediate frames interpolate smoothly between rest and extreme.
- Frames within a row keep the SAME camera distance + ground line; only the limbs / weapon move.

═══ STYLE ═══
${
  input.style === 'pixel-32'
    ? 'Crisp 32×32-style pixel art, limited 16-color palette per character, hard pixel edges, no anti-aliasing.'
    : 'Clean ' + input.style + ' chibi sprite, flat shading, bold outlines, transparent background for cells.'
}

═══ CRITICAL ═══
- TRANSPARENT background — every cell except the character must be fully transparent.
- Character occupies ~60% of cell area, vertically centered.
- DO NOT add grid borders, frame numbers, text labels, or any UI chrome.
- DO NOT wrap a single direction across two rows.  Each direction = EXACTLY ${cols} frames in ONE row.
- DO NOT change the character's identity (hair / outfit / weapon) between frames or between rows.
- Maintain consistent silhouette size across all ${dirCount * cols} cells.
`.trim();
}

export function planSpriteSheetLayout(
  framesPerDir: number,
  directions: SpriteDirection[],
  frameSize: number,
): { totalW: number; totalH: number; cellW: number; cellH: number; cols: number; rows: number } {
  return {
    cols: framesPerDir,
    rows: directions.length,
    cellW: frameSize,
    cellH: frameSize,
    totalW: framesPerDir * frameSize,
    totalH: directions.length * frameSize,
  };
}
