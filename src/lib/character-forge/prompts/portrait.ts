import type { PortraitView, StylePreset } from '../types';

/**
 * Style presets — kept tiny on purpose.  Each preset is a free-text suffix
 * appended to the user's prompt; vendors interpret these tokens consistently
 * enough that we don't need vendor-specific reword maps.  Add a new preset by
 * extending StylePreset (in types.ts) and adding the corresponding line here.
 */
const STYLE_BLOCK: Record<StylePreset, string> = {
  'anime-hd-flat':
    'anime style, flat shading, clean line-art, vibrant saturated colors, sharp focus, key visual artwork',
  'semi-realistic':
    'semi-realistic painterly style, soft anatomical shading, cinematic lighting, painted concept art',
  'pixel-32':
    '32x32 retro pixel art, deliberate pixelation, limited 16-color palette, clean dithering',
  'cell-shaded':
    'cell-shaded toon rendering, hard black outlines, two-tone shadow blocks, Ghibli-esque atmosphere',
  watercolor:
    'watercolor illustration, soft wet edges, paper grain texture, gentle gradient washes',
  cyberpunk:
    'cyberpunk illustration, neon teal-magenta rim lights, holographic accents, gritty atmospheric mood',
};

const VIEW_INSTRUCTION: Record<PortraitView, string> = {
  front:
    'FULL-BODY FRONT-FACING portrait, character standing tall, both arms visible, neutral confident pose, looking directly at viewer',
  side:
    'FULL-BODY LEFT-SIDE profile, character facing left at 90°, both feet aligned, weight on back leg, hair and weapon silhouettes preserved',
  back:
    'FULL-BODY BACK view, character facing away from viewer, hair / cape / weapon visible from rear, no facial features',
};

const COMMON_RULES = `
═══ CRITICAL OUTPUT RULES ═══
1. Single portrait of ONE character only — DO NOT compose a turnaround triptych, DO NOT add multiple poses.
2. PURE WHITE background, zero shadow under the feet.
3. Character occupies ~80% of the canvas vertical extent; both feet visible; ample breathing room above the head.
4. NO text, NO callouts, NO measurement guides, NO UI chrome.
5. Symmetrical balance — character roughly centered horizontally.
6. Maintain the SAME character identity (face / outfit / weapon) across multiple views when re-generated.
`.trim();

export interface PortraitPromptInput {
  userDescription: string;
  style: StylePreset;
  view: PortraitView;
  /** Optional anchor describing previously generated views so the model keeps
   * face / outfit / weapon consistent across the turnaround. */
  consistencyHint?: string;
}

/**
 * Build the final prompt sent to the image vendor.  Order matters: identity
 * first (so style instructions never wash out the character), then view, then
 * style, then global rules.  Vendors weight earlier tokens slightly higher in
 * the latent space.
 */
export function buildPortraitPrompt(input: PortraitPromptInput): string {
  const blocks: string[] = [];
  blocks.push('CHARACTER IDENTITY:');
  blocks.push(input.userDescription.trim());
  if (input.consistencyHint) {
    blocks.push('');
    blocks.push('CONSISTENCY ANCHOR (must match previous views):');
    blocks.push(input.consistencyHint.trim());
  }
  blocks.push('');
  blocks.push('VIEW:');
  blocks.push(VIEW_INSTRUCTION[input.view]);
  blocks.push('');
  blocks.push('STYLE:');
  blocks.push(STYLE_BLOCK[input.style]);
  blocks.push('');
  blocks.push(COMMON_RULES);
  return blocks.join('\n');
}

export function getStylePreset(id: string): StylePreset {
  return (Object.prototype.hasOwnProperty.call(STYLE_BLOCK, id) ? id : 'anime-hd-flat') as StylePreset;
}

export const STYLE_IDS = Object.keys(STYLE_BLOCK) as StylePreset[];
