export type PortraitView = 'front' | 'side' | 'back';
export type SpriteAction = 'walk' | 'idle' | 'attack';
export type SpriteDirection = 'down' | 'left' | 'right' | 'up';

/**
 * 角色定位。下游动画工作台(wb-anim)据此分流:hero/npc/monster 走角色动画
 * 管线(pixel-char / spine / video),vehicle 走载具设计动画管线
 * (vehicle-design)。来源是 wb-character 前端的 profile.characterRole。
 * 旧 manifest 缺此字段时按 'hero' 兜底。
 */
export type CharacterRole = 'hero' | 'npc' | 'monster' | 'vehicle';

export type StylePreset =
  | 'anime-hd-flat'
  | 'semi-realistic'
  | 'pixel-32'
  | 'cell-shaded'
  | 'watercolor'
  | 'cyberpunk';

export interface PromptInput {
  user: string;
  style: StylePreset;
  refImage?: string | null;
}

/**
 * CharacterManifest schemaVersion history:
 *   v1 — portrait + sprites + variants only. Read-compat via {@link upgradeManifestV1ToV2}.
 *   v2 — adds `pipelines.*` slot for the 9-pipeline future
 *        (pixel/spine/video/vfx/monster/turnaround/vehicle, plus moves
 *        sprite-sheet under pipelines for symmetry with the new entries).
 *        Promised in packages/marketplace/plugins/wb-character/SKILL.md.
 *
 * Manifest is read by both UI (iframe panel) and AI tool callers — the
 * union below is the canonical type. Producers should always emit v2; the
 * `| LegacyCharacterManifestV1` arm exists purely so disk reads of older
 * manifests typecheck without `as any` in caller code.
 */
export interface LegacyCharacterManifestV1 {
  schemaVersion: 1;
  charId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  prompt: PromptInput;
  portrait: Partial<Record<PortraitView, string>>;
  sprites: Partial<Record<SpriteAction, SpriteSheetEntry>>;
  variants: Array<{ id: string; label: string; portrait: Partial<Record<PortraitView, string>> }>;
}

export interface CharacterManifestV2 {
  schemaVersion: 2;
  charId: string;
  name: string;
  /** 角色定位,决定下游 wb-anim 的管线分流。缺省按 'hero'。 */
  role?: CharacterRole;
  createdAt: string;
  updatedAt: string;
  prompt: PromptInput;
  portrait: Partial<Record<PortraitView, string>>;
  sprites: Partial<Record<SpriteAction, SpriteSheetEntry>>;
  variants: Array<{ id: string; label: string; portrait: Partial<Record<PortraitView, string>> }>;
  pipelines: CharacterPipelineSlots;
}

export type CharacterManifest = CharacterManifestV2 | LegacyCharacterManifestV1;

export interface CharacterPipelineSlots {
  pixel?: PixelArtifact;
  spine?: SpineArtifact;
  video?: VideoArtifact;
  vfx?: VfxArtifact[];
  monster?: MonsterArtifact;
  turnaround?: TurnaroundArtifact;
  vehicle?: VehicleArtifact;
}

interface PipelineArtifactBase {
  generatedAt: string;
  model?: string;
  costEstimate?: { usd: number; vendor: string };
}

export interface PixelArtifact extends PipelineArtifactBase {
  sheet: string;
  directions: SpriteDirection[];
  frameSize: { w: number; h: number };
}

export interface SpineArtifact extends PipelineArtifactBase {
  spineJson: string;
  atlas: string;
  texture: string;
}

export interface VideoArtifact extends PipelineArtifactBase {
  video: string;
  durationSec: number;
  frames?: string[];
}

export interface VfxArtifact extends PipelineArtifactBase {
  id: string;
  label: string;
  sheet?: string;
  particles?: string;
}

export interface MonsterArtifact extends PipelineArtifactBase {
  sheet: string;
  directions: SpriteDirection[];
  actions: SpriteAction[];
}

export interface TurnaroundArtifact extends PipelineArtifactBase {
  views: Partial<Record<PortraitView | 'three-quarter', string>>;
}

export interface VehicleArtifact extends PipelineArtifactBase {
  sheet: string;
  meshUrl?: string;
}

export interface SpriteSheetEntry {
  sheet: string;
  framesPerDir: number;
  directions: SpriteDirection[];
  frameSize: { w: number; h: number };
  generatedAt: string;
}

export interface CharacterListItem {
  charId: string;
  name: string;
  role?: CharacterRole;
  portraitUrl: string | null;
  createdAt: string;
  hasSprites: boolean;
}

export interface GeneratePortraitArgs {
  slug: string;
  prompt: string;
  style?: StylePreset;
  views?: PortraitView[];
  name?: string;
  charId?: string;
  model?: 'seedream' | 'nano-banana' | 'azure-gpt-image';
  size?: '1k' | '2k' | '4k';
  refImageBase64?: string;
}

/**
 * 客户端管线(wb-character 前端走 /__ce-api__ 生图、自己落盘字节)产出最终
 * 设定图后,用这个把一份真正的 manifest.json 写盘,让 listCharacters /
 * getCharacter / 下游 wb-anim 能发现该角色。与 generatePortrait 不同:不在
 * server 端生图,只登记已上传的 portrait 相对路径 + role 元数据。
 */
export interface UpsertManifestArgs {
  slug: string;
  charId: string;
  name?: string;
  role?: CharacterRole;
  /** 已通过 /upload-asset 落盘的正面图相对路径,如 "portrait/current.png"。 */
  portraitFront?: string;
  /** 可选的其它视图。 */
  portrait?: Partial<Record<PortraitView, string>>;
  promptText?: string;
}

export interface UpsertManifestResult {
  charId: string;
  name: string;
  role: CharacterRole;
  manifestPath: string;
  portraitUrl: string | null;
}

export interface GeneratePortraitResult {
  charId: string;
  name: string;
  files: Array<{ view: PortraitView; path: string; url: string }>;
  manifestPath: string;
  model: string;
  costEstimate?: { usd: number; vendor: string };
}

export interface GenerateSpriteSheetArgs {
  slug: string;
  charId: string;
  action?: SpriteAction;
  directions?: SpriteDirection[];
  framesPerDir?: number;
  frameSize?: 64 | 96 | 128;
  model?: 'nano-banana' | 'azure-gpt-image';
}

export interface GenerateSpriteSheetResult {
  charId: string;
  action: SpriteAction;
  sheet: { path: string; url: string };
  atlas: Array<{ dir: SpriteDirection; framesPerDir: number; frameSize: number }>;
}

export interface RouterCtx {
  /** forgeax project root, absolute */
  projectRoot: string;
  /** bus event emitter (loose-typed, plugin shouldn't depend on bus internals) */
  emit?: (name: string, args: Record<string, unknown>) => void;
  /** env reader; tests can inject overrides without polluting process.env */
  env: Record<string, string | undefined>;
}
