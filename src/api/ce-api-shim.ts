/**
 * /__ce-api__/* —— studio-host shim for the wb-character iframe plugin.
 *
 * Background: packages/marketplace/plugins/wb-character/src/* still hits the
 * vite-dev plugin's `/__ce-api__/<endpoint>` (88 call sites) through plain
 * fetch — Bridge.ts STUDIO_HOST_MODE was defined but the call sites bypass it.
 * The submodule is built as static assets and served at /plugins/wb-character/*
 * by main.ts, so without this shim every "generate portrait / pixel / spine /
 * vfx" click would 404.
 *
 * Strategy: terminate the legacy endpoints here, forward to existing host libs
 * (@server-lib/character-forge dispatcher → image-gateway, lib/llm-gateway,
 * raw FS for persistence). Submodule code stays unchanged — this is the
 * 接线层 until we push the iframe to use Bridge.ts → /api/wb/character/*.
 *
 * Envelope convention: every response is `{success: boolean, ...}` with HTTP
 * 200 even on failure (Hono `c.json`). The iframe checks `success` first and
 * renders `error` inline; an HTTP-level error would manifest as "network
 * failure" toast and lose context.
 *
 * Wired for Spine: /gemini-text with inputImages (vision prompt), /generate-image
 * with multiple inputImages or aspectRatio (Gemini multi-ref image gen).
 *
 * Deferred (returns 503): monster/**, video-generate, analyze-ultimate,
 * magic-prompt, remove-bg, enhance-prompt, pixelart, character-turnaround.
 * These need Python pipelines / MCP servers that aren't wired in studio. The
 * iframe surfaces a friendly toast on 503 — see VFX_CHANGES.md.
 */

import { Hono } from 'hono';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { complete, type ChatMessage } from '../lib/llm-gateway';
import { ImageDispatcher } from '../lib/character-forge/clients/dispatcher';
import { vendorForModel } from '../lib/image-gateway';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import {
  createLitellmVideoTask,
  getLitellmVideoStatus,
  downloadLitellmVideoContent,
  litellmVideoConfigured,
} from '../lib/video-gateway/litellm-video';
import {
  arkVideoConfigured,
  createArkVideoTask,
  getArkVideoStatus,
  downloadArkVideoContent,
  isArkTaskId,
} from '../lib/video-gateway/ark-video';
import { generateReelImage, litellmImageConfigured } from '../lib/image-gateway/litellm-reel-image';
import { createLitellmSpeech, litellmTtsConfigured } from '../lib/audio-gateway/litellm-tts';
import { createDoubaoSpeech, doubaoTtsConfigured } from '../lib/audio-gateway/doubao-tts';
import { createMinimaxSpeech, minimaxTtsConfigured } from '../lib/audio-gateway/minimax-tts';
import { createMinimaxMusic, minimaxMusicConfigured } from '../lib/audio-gateway/minimax-music';
import {
  inspectUiAssetCanvas,
  normalizeStandaloneUiAsset,
} from '../../../marketplace/plugins/wb-ui/src/pipelines/ui-design/ui-asset-cleanup';
import {
  fitImageToPolicy,
  type ImagePreflightPolicy,
} from '../llm/image-compression.js';
import {
  activeIconModuleSpecs,
  buildModuleIconBrief,
  MODULE_ICON_GLYPHS,
  resolveIconSlotCount as resolveIconSlotCountFromSpecs,
} from '../../../marketplace/plugins/wb-ui/src/pipelines/ui-design/icon-semantics';
import {
  buildUiDesignAssetOutputPath,
  freshUiGenerationBody,
  uiDesignSessionPrefix,
} from '../../../marketplace/plugins/wb-ui/src/pipelines/ui-design/ui-design-generation-path';
import { buildAssetPrompt } from '../../../marketplace/plugins/wb-ui/server/api-plugin';

export interface CeApiShimCtx {
  projectRoot: string;
  env: Record<string, string | undefined>;
}

// All shim-owned state lives under <projectRoot>/.forgeax/wb-character/. The
// host already whitelists .forgeax/games for /api/files; wb-character/ is a
// sibling tree (settings + spine sessions + character-export). Workspace
// games live at .forgeax/games/<gameId>/ per project_packages_layout.md.
function shimRoot(ctx: CeApiShimCtx): string {
  return resolve(ctx.projectRoot, '.forgeax/wb-character');
}
function workspaceGamesDir(ctx: CeApiShimCtx): string {
  return resolve(ctx.projectRoot, '.forgeax/games');
}
function spineDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'spine');
}
function spineHistoryDir(ctx: CeApiShimCtx): string {
  return resolve(spineDir(ctx), 'history');
}
function characterExportDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'character-export');
}
/** wb-reel litellm video downloads land here, re-served via /video-file/:id. */
function reelVideoDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'reel-videos');
}
const MAX_SPINE_HISTORY = 20;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 128 && /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/.test(id);
}

function b64ToFile(dataUrl: string, filePath: string): void {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    writeFileSync(filePath, dataUrl, 'utf-8');
    return;
  }
  writeFileSync(filePath, Buffer.from(match[2], 'base64'));
}

function fileToB64(filePath: string, mime = 'image/png'): string | null {
  if (!existsSync(filePath)) return null;
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
}

interface GenerateImageBody {
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  inputImageBase64?: string;
  inputImages?: Array<{ base64: string; mimeType?: string }>;
  role?: 'concept-art' | 'sprite-frame';
}

interface GeminiTextBody {
  prompt?: string;
  system?: string;
  model?: string;
  inputImages?: Array<{ base64: string; mimeType?: string }>;
}

interface ChatBody {
  messages?: Array<{ role: string; content: string | unknown }>;
  system?: string;
  model?: string;
  maxTokens?: number;
}

/** wb-reel 统一文本（litellm）请求体 —— 见 /reel-chat[-stream] 路由。 */
interface ReelChatBody {
  model?: string;
  system?: string;
  user?: string;
  images?: Array<{ dataUrl?: string }>;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

// wb-reel 文本默认模型（litellm 可用，见 /v1/models）。前端不指定时用它。
const DEFAULT_REEL_TEXT_MODEL = 'claude-opus-4-8';

/** LITELLM_PROXY_BASE_URL 已含 /v1（与 chat transport 一致）。 */
function litellmChatBase(): string {
  return (process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
}

type OpenAiChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };

/** TextRequest(system/user/images/jsonMode) → OpenAI-compat messages（含 vision）。 */
function buildReelChatMessages(body: ReelChatBody): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  const sys =
    (body.system ?? '') +
    (body.jsonMode
      ? '\n\n你必须只返回单一合法 JSON 对象（无前后说明、无 markdown 代码块）。'
      : '');
  if (sys.trim()) messages.push({ role: 'system', content: sys });
  const imgs = (body.images ?? []).filter((i): i is { dataUrl: string } => !!i?.dataUrl);
  const userText = body.user ?? '';
  if (imgs.length > 0) {
    const content: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = imgs.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }));
    content.push({ type: 'text', text: userText });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userText });
  }
  return messages;
}

type UiAssetKind = 'buttonNormal' | 'buttonPrimary' | 'titleDeco' | 'panelTexture' | 'icons' | 'background' | 'npc' | 'shopItems' | 'weapons';

interface ModuleAssetSpec {
  id?: string;
  label?: string;
  category?: string;
  layer?: string;
  zone?: string;
  description?: string;
  aiHint?: string;
  assetRoles?: string[];
}

interface UiDesignGenerateAssetsBody {
  genre?: string;
  style?: string;
  styleTone?: string;
  screens?: string[];
  sceneDesc?: string;
  styleBoardPrompt?: string;
  assetPromptNotes?: string;
  assetKinds?: UiAssetKind[];
  styleKey?: string;
  genreKey?: string;
  generationNonce?: string;
  generationAttempt?: number;
  moduleAssetSpecs?: ModuleAssetSpec[];
  iconSlotCount?: number;
  /** 仅生成指定下标的功能图标（0-based），用于并行分槽请求 */
  iconIndex?: number;
  /** 与 iconIndex 对应的模块 id，用于提示词与输出路径去重 */
  iconModuleId?: string;
}

interface UiGeneratedAssets {
  backgrounds: Record<string, string>;
  npc?: string;
  shopItems: string[];
  weapons: string[];
  panelTexture?: string;
  icons: string[];
  buttonNormal?: string;
  buttonPrimary?: string;
  titleDeco?: string;
}

function imageBytesToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function getMcpHost(): string {
  return process.env.MCP_HOST || '127.0.0.1';
}

function getMcpGeminiImagePort(): number {
  return Number(process.env.MCP_GEMINI_IMAGE_PORT || '3100');
}

function getMcpJimengImagePort(): number {
  return Number(process.env.MCP_JIMENG_IMAGE_PORT || '3103');
}

function mcpCall(host: string, port: number, tool: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolveMcp, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: args },
      id: Date.now(),
    });
    const req = httpRequest({
      hostname: host,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 180_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolveMcp(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('MCP parse error: ' + e)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MCP timeout')); });
    req.write(payload);
    req.end();
  });
}

function dataUrlFromMcpResult(result: any): string | null {
  const content = result?.result?.content ?? result?.content ?? [];
  for (const item of content) {
    if (item?.type === 'image' && item?.data) {
      return `data:${item.mimeType ?? 'image/png'};base64,${item.data}`;
    }
    const textPath = typeof item?.text === 'string'
      ? item.text.match(/workspace[\\/][^\s"'`]+?\.(?:png|jpg|jpeg|webp)/i)?.[0]
      : '';
    const pathValue = item?.path || item?.file || textPath;
    if (typeof pathValue === 'string') {
      const absPath = resolve(ctxProjectRootForMcpOutput(), pathValue.replace(/^workspace[\\/]/, ''));
      if (existsSync(absPath)) {
        const buf = readFileSync(absPath);
        const ext = absPath.split('.').pop()?.toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        return `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
  }
  return null;
}

async function directGeminiTextToImage(
  env: Record<string, string | undefined>,
  prompt: string,
  aspectRatio = '1:1',
): Promise<string | null> {
  const gemini = await shimGeminiMultimodalImage(env, {
    prompt,
    aspectRatio: normalizeGeminiAspectRatio(aspectRatio),
    model: 'gemini-2.5-flash-image',
  });
  if (gemini.success && gemini.imageBase64) {
    return `data:${gemini.mimeType ?? 'image/png'};base64,${gemini.imageBase64}`;
  }
  return null;
}

async function mcpTextToImage(
  env: Record<string, string | undefined>,
  prompt: string,
  outputPath: string,
  aspectRatio = '1:1',
): Promise<string | null> {
  const host = getMcpHost();
  const providers = [
    {
      name: 'Gemini',
      port: getMcpGeminiImagePort(),
      args: { prompt, outputPath, aspectRatio },
    },
  ];

  let lastError = '';
  for (const provider of providers) {
    try {
      const result = await mcpCall(host, provider.port, 'text_to_image', {
        ...provider.args,
        aspectRatio: normalizeGeminiAspectRatio(aspectRatio),
      });
      const dataUrl = dataUrlFromMcpResult(result);
      if (dataUrl) return dataUrl;
      const text = (result?.result?.content ?? result?.content ?? [])
        .map((item: any) => typeof item?.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join(' ');
      const textPath = text.match(/workspace[\\/][^\s"'`]+?\.(?:png|jpg|jpeg|webp)/i)?.[0];
      if (textPath && /successfully completed/i.test(text)) {
        throw new Error(`${provider.name} MCP 已生成图片，但当前运行中的 MCP 服务仍只返回内部文件路径 ${textPath}，没有返回 image/base64。请重启 image-gemini MCP 进程加载已更新的 server.py。`);
      } else if (text) {
        lastError = text;
      }
    } catch (e) {
      lastError = (e as Error).message;
      if (lastError.includes('MCP 已生成图片')) {
        break;
      }
    }
  }

  if (getGeminiKey(env)) {
    const direct = await directGeminiTextToImage(env, prompt, aspectRatio);
    if (direct) {
      console.info('[ui-design/generate-assets] MCP unavailable; used direct Gemini API fallback');
      return direct;
    }
    if (!lastError) lastError = 'Gemini 直连生图未返回图片';
  } else if (!lastError) {
    lastError = `image-gemini MCP (${getMcpGeminiImagePort()}) 未响应，且未配置 GEMINI_API_KEY`;
  }

  if (lastError) {
    console.warn('[ui-design/generate-assets] text_to_image failed:', lastError);
  }
  return null;
}

function ctxProjectRootForMcpOutput(): string {
  return process.env.FORGEAX_PROJECT_ROOT ?? resolve(import.meta.dir, '../../..');
}

function isUiIconLikeKind(kind: string): boolean {
  return kind === 'icons' || kind === 'npc' || kind === 'shopItems' || kind === 'weapons';
}

function moduleSpecs(body: UiDesignGenerateAssetsBody): ModuleAssetSpec[] {
  return Array.isArray(body.moduleAssetSpecs) ? body.moduleAssetSpecs.filter(item => item && typeof item === 'object') : [];
}

function resolveIconSlotCount(body: UiDesignGenerateAssetsBody): number {
  const explicit = Number(body.iconSlotCount);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(4, Math.min(8, Math.floor(explicit)));
  }
  return resolveIconSlotCountFromSpecs(moduleSpecs(body));
}

function iconPromptExtraForSlot(body: UiDesignGenerateAssetsBody, idx: number): string {
  const specs = moduleSpecs(body);
  const spec = activeIconModuleSpecs(specs)[idx];
  if (!spec) return '';
  const brief = buildModuleIconBrief(spec, idx, (body.genreKey as 'open-world') || 'open-world');
  return [
    `Slot ${idx + 1} module「${brief.label}」(${brief.moduleId}).`,
    `Must depict: ${brief.visualZh}.`,
    `Player function: ${brief.symbolZh}.`,
    body.generationNonce ? `Variation seed ${body.generationNonce}.` : '',
  ].filter(Boolean).join(' ');
}

function promptForUiAssetKind(kind: UiAssetKind, body: UiDesignGenerateAssetsBody, variant = ''): string {
  const genre = body.genre ?? '游戏';
  const style = body.style ?? body.styleKey ?? 'modern game UI';
  const styleTone = body.styleTone ?? '';
  const styleKey = body.styleKey ?? '';
  const genreKey = body.genreKey ?? '';
  const sceneDesc = body.sceneDesc ?? '';
  const moduleAssetSpecs = Array.isArray(body.moduleAssetSpecs) ? body.moduleAssetSpecs : [];
  const promptNotes = [
    body.styleBoardPrompt,
    body.assetPromptNotes,
    body.generationNonce ? `Fresh generation seed: ${body.generationNonce}, attempt ${body.generationAttempt ?? 1}.` : '',
  ].filter(Boolean).join(' ');

  switch (kind) {
    case 'buttonPrimary':
      return buildAssetPrompt('button_primary', 'ui', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    case 'buttonNormal':
      return buildAssetPrompt('button_normal', 'ui', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    case 'titleDeco':
      return buildAssetPrompt('title_deco', 'ui', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    case 'panelTexture':
      return buildAssetPrompt('panel_texture', 'ui', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    case 'icons': {
      const idx = typeof body.iconIndex === 'number' && body.iconIndex >= 0
        ? Math.floor(body.iconIndex)
        : Math.max(0, (Number(variant.match(/\d+/)?.[0]) || 1) - 1);
      const slotExtra = iconPromptExtraForSlot(body, idx);
      const mergedNotes = [promptNotes, slotExtra].filter(Boolean).join(' ');
      return buildAssetPrompt(`icon_${idx}`, 'ui', genre, style, styleTone, sceneDesc, mergedNotes, styleKey, genreKey, moduleAssetSpecs);
    }
    case 'background':
      return buildAssetPrompt('bg', variant || 'hud', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    case 'shopItems': {
      const idx = Math.max(0, (Number(variant.match(/\d+/)?.[0]) || 1) - 1);
      return buildAssetPrompt(`item-${idx}`, 'shop', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    }
    case 'weapons': {
      const idx = Math.max(0, (Number(variant.match(/\d+/)?.[0]) || 1) - 1);
      return buildAssetPrompt(`weapon-${idx}`, 'weapon-select', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
    }
    default:
      return buildAssetPrompt(kind, 'ui', genre, style, styleTone, sceneDesc, promptNotes, styleKey, genreKey, moduleAssetSpecs);
  }
}

function uiAssetAspectRatio(kind: UiAssetKind): string {
  if (kind === 'background') return '16:9';
  // Gemini image API only accepts fixed ratios; 21:9 is the widest supported option for button/title chrome.
  if (kind === 'buttonPrimary' || kind === 'buttonNormal') return '21:9';
  if (kind === 'titleDeco') return '21:9';
  return '1:1';
}

const GEMINI_IMAGE_ASPECT_RATIOS = new Set([
  '1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);

function normalizeGeminiAspectRatio(aspectRatio: string): string {
  if (GEMINI_IMAGE_ASPECT_RATIOS.has(aspectRatio)) return aspectRatio;
  if (aspectRatio === '4:1' || aspectRatio === '3:1') return '21:9';
  return '1:1';
}

async function generateUiDesignAsset(
  env: Record<string, string | undefined>,
  body: UiDesignGenerateAssetsBody,
  kind: UiAssetKind,
  variant = '',
): Promise<string | null> {
  try {
    return await generateUiDesignAssetInner(env, body, kind, variant);
  } catch (e) {
    console.error(`[ui-design/generate-assets] ${kind} generation error:`, e);
    return null;
  }
}

async function generateUiDesignAssetInner(
  env: Record<string, string | undefined>,
  body: UiDesignGenerateAssetsBody,
  kind: UiAssetKind,
  variant = '',
): Promise<string | null> {
  const prompt = promptForUiAssetKind(kind, body, variant);
  const prefix = uiDesignSessionPrefix(body);
  const outputPath = buildUiDesignAssetOutputPath(
    prefix,
    kind,
    variant,
    body.generationAttempt ?? 1,
  );
  const absOutput = resolve(ctxProjectRootForMcpOutput(), outputPath.replace(/^workspace[\\/]/, ''));
  if (existsSync(absOutput)) {
    rmSync(absOutput, { force: true });
  }
  const aspectRatio = uiAssetAspectRatio(kind);
  const raw = await mcpTextToImage(env, prompt, outputPath, aspectRatio);
  if (!raw) return null;
  if (kind === 'background') return raw;

  const iconLike = isUiIconLikeKind(kind);
  const normalized = await normalizeStandaloneUiAsset(raw, {
    mode: iconLike ? 'icon' : 'chrome',
    fillRatio: iconLike ? 0.62 : 0.9,
    chromeEdgeRefine: body.styleKey === 'sci-fi' || body.styleKey === 'realistic-military' ? 'dark-ui' : undefined,
  });
  const report = await inspectUiAssetCanvas(normalized);
  const strictCutoutIssue = iconLike
    ? isStrictIconCutoutIssue(report)
    : report.opaqueEdgePixels > 0
      || report.transparentCornerDirtyPixels > 0
      || report.transparentDirtyPixels > 0
      || report.fragmentationRatio > 0.42
      || report.largestComponentRatio < 0.56;

  if (strictCutoutIssue) {
    console.warn(`[ui-design/generate-assets] ${kind} cutout inspection warning`, report);
    if (iconLike && isUsableIconCutout(report)) {
      console.info(`[ui-design/generate-assets] ${kind} accepted after relaxed icon QA`);
      return normalized;
    }
    if (iconLike) return null;
  }
  return normalized;
}

function isStrictIconCutoutIssue(report: Awaited<ReturnType<typeof inspectUiAssetCanvas>>): boolean {
  return report.opaqueEdgePixels > 0
    || report.transparentCornerDirtyPixels > 0
    || report.transparentDirtyPixels > 0
    || report.fragmentationRatio > 0.22
    || report.largestComponentRatio < 0.78
    || report.opaqueBoundsFillRatio > 0.82
    || report.opaqueBoundsEdgeRatio > 0.55
    || report.opaquePinkBackdropRatio > 0.18
    || report.opaquePlateLikeRatio > 0.72;
}

/** 严格 QA 未过，但主体完整、残底已清：预览阶段可接受，避免整批失败。 */
function isUsableIconCutout(report: Awaited<ReturnType<typeof inspectUiAssetCanvas>>): boolean {
  return report.largestComponentRatio >= 0.78
    && report.fragmentationRatio <= 0.22
    && report.opaquePinkBackdropRatio <= 0.18
    && report.opaqueEdgePixels === 0
    && report.transparentDirtyPixels === 0;
}

const UI_ICON_RETRY_ATTEMPTS = 3;
const UI_CHROME_BATCH_CONCURRENCY = 3;
const UI_ICON_BATCH_CONCURRENCY = 3;

async function generateCleanUiIconAsset(
  env: Record<string, string | undefined>,
  body: UiDesignGenerateAssetsBody,
  kind: UiAssetKind,
  variant = '',
): Promise<string | null> {
  const idx = typeof body.iconIndex === 'number' && body.iconIndex >= 0
    ? Math.floor(body.iconIndex)
    : Math.max(0, (Number(variant.match(/\d+/)?.[0]) || 1) - 1);
  const spec = activeIconModuleSpecs(moduleSpecs(body))[idx];
  const moduleId = spec?.id || body.iconModuleId || '';
  const anchor = moduleId ? MODULE_ICON_GLYPHS[moduleId]?.anchor : undefined;
  const brief = spec ? buildModuleIconBrief(spec, idx, (body.genreKey as 'open-world') || 'open-world') : null;
  const retryNotes = [
    '',
    brief
      ? `RETRY: previous output failed QA for「${brief.label}」. Draw ONLY「${brief.visualZh}」(${anchor || brief.anchor}) — NOT abstract dash, NOT compass, NOT empty frame, NOT unrelated metaphor. Pure #FFFFFF background.`
      : `Previous icon rejected: UI chrome plate, sticker with thick outer ring, or dirty white fringe. Regenerate ONE flat filled vector glyph on pure #FFFFFF only.`,
  ];
  for (let attempt = 0; attempt < UI_ICON_RETRY_ATTEMPTS; attempt += 1) {
    const nextBody: UiDesignGenerateAssetsBody = {
      ...body,
      assetPromptNotes: [body.assetPromptNotes, retryNotes[attempt]].filter(Boolean).join(' '),
      generationAttempt: (body.generationAttempt ?? 1) + attempt,
      generationNonce: body.generationNonce
        ? `${body.generationNonce}-retry-${attempt}`
        : `retry-${Date.now()}-${attempt}`,
    };
    const generated = await generateUiDesignAsset(env, nextBody, kind, variant);
    if (generated) return generated;
  }
  return null;
}

function uiGenerateFailureHint(
  env: Record<string, string | undefined>,
  failedKinds: string[],
): string {
  if (failedKinds.length === 0) return '';
  if (!getGeminiKey(env)) {
    return '（请配置 GEMINI_API_KEY，或启动 image-gemini MCP 端口 3100）';
  }
  if (failedKinds.some((kind) => kind.startsWith('icons'))) {
    return '（图标未通过自动抠图质检，可点击重试）';
  }
  return '';
}

async function runUiAssetBatch(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map(async (task) => {
      try {
        await task();
      } catch (e) {
        console.error('[ui-design/generate-assets] batch task error:', e);
      }
    }));
  }
}

async function handleUiDesignGenerateAssetsReal(ctx: CeApiShimCtx, body: UiDesignGenerateAssetsBody): Promise<Record<string, unknown>> {
  body = freshUiGenerationBody(body);
  const screens = Array.isArray(body.screens) ? body.screens.filter((v): v is string => typeof v === 'string') : [];
  const assetKinds = Array.isArray(body.assetKinds) ? new Set(body.assetKinds) : new Set<UiAssetKind>();
  const wants = (kind: UiAssetKind): boolean => assetKinds.size === 0 || assetKinds.has(kind);
  const assets: UiGeneratedAssets = { backgrounds: {}, shopItems: [], weapons: [], icons: [] };
  const failedKinds: string[] = [];

  try {
    const chromeTasks: Array<() => Promise<void>> = [];
    const env = ctx.env;
    if (wants('buttonPrimary')) {
      chromeTasks.push(async () => {
        assets.buttonPrimary = await generateUiDesignAsset(env, body, 'buttonPrimary') ?? undefined;
        if (!assets.buttonPrimary) failedKinds.push('buttonPrimary');
      });
    }
    if (wants('buttonNormal')) {
      chromeTasks.push(async () => {
        assets.buttonNormal = await generateUiDesignAsset(env, body, 'buttonNormal') ?? undefined;
        if (!assets.buttonNormal) failedKinds.push('buttonNormal');
      });
    }
    if (wants('titleDeco')) {
      chromeTasks.push(async () => {
        assets.titleDeco = await generateUiDesignAsset(env, body, 'titleDeco') ?? undefined;
        if (!assets.titleDeco) failedKinds.push('titleDeco');
      });
    }
    if (wants('panelTexture')) {
      chromeTasks.push(async () => {
        assets.panelTexture = await generateUiDesignAsset(env, body, 'panelTexture') ?? undefined;
        if (!assets.panelTexture) failedKinds.push('panelTexture');
      });
    }
    await runUiAssetBatch(chromeTasks, UI_CHROME_BATCH_CONCURRENCY);

    if (wants('icons')) {
      const iconCount = resolveIconSlotCount(body);
      assets.icons = Array.from({ length: iconCount }, () => '');
      const iconIndices = typeof body.iconIndex === 'number' && body.iconIndex >= 0
        ? [Math.min(Math.floor(body.iconIndex), iconCount - 1)]
        : Array.from({ length: iconCount }, (_, i) => i);
      const activeIcons = activeIconModuleSpecs(moduleSpecs(body));
      const iconTasks = iconIndices.map((i) => async () => {
        const moduleId = activeIcons[i]?.id || '';
        const slotBody: UiDesignGenerateAssetsBody = {
          ...body,
          iconIndex: i,
          iconModuleId: moduleId,
        };
        const fileTag = moduleId ? `icon-${moduleId}` : `icon-${i + 1}`;
        assets.icons[i] = (await generateCleanUiIconAsset(env, slotBody, 'icons', fileTag)) ?? '';
      });
      await runUiAssetBatch(iconTasks, UI_ICON_BATCH_CONCURRENCY);
      const failedIconIndices = typeof body.iconIndex === 'number' && body.iconIndex >= 0
        ? [Math.min(Math.floor(body.iconIndex), iconCount - 1)]
        : iconIndices;
      failedIconIndices.forEach((i) => {
        if (!assets.icons[i]) failedKinds.push(`icons:${i}`);
      });
    }
    if (wants('background')) {
      const bgTasks = screens.map(screen => async () => {
        const bg = await generateUiDesignAsset(env, body, 'background', screen);
        if (bg) assets.backgrounds[screen] = bg;
        else failedKinds.push(`background:${screen}`);
      });
      await runUiAssetBatch(bgTasks, 2);
    }
    if (wants('shopItems')) {
      assets.shopItems = Array.from({ length: 4 }, () => '');
      const shopTasks = Array.from({ length: 4 }, (_, i) => async () => {
        const item = await generateCleanUiIconAsset(env, body, 'shopItems', `item ${i + 1}`);
        assets.shopItems[i] = item ?? '';
        if (!item) failedKinds.push(`shopItems:${i}`);
      });
      await runUiAssetBatch(shopTasks, 3);
    }
    if (wants('weapons')) {
      assets.weapons = Array.from({ length: 4 }, () => '');
      const weaponTasks = Array.from({ length: 4 }, (_, i) => async () => {
        const weapon = await generateCleanUiIconAsset(env, body, 'weapons', `weapon ${i + 1}`);
        assets.weapons[i] = weapon ?? '';
        if (!weapon) failedKinds.push(`weapons:${i}`);
      });
      await runUiAssetBatch(weaponTasks, 3);
    }
    if (failedKinds.length > 0) {
      const hint = uiGenerateFailureHint(env, failedKinds);
      return { success: false, error: `组件生成失败: ${failedKinds.join(', ')}${hint}`, assets, failedKinds };
    }
    return { success: true, assets };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'UI 组件素材生成失败', assets, failedKinds };
  }
}

function getGeminiKey(env: Record<string, string | undefined>): string {
  return (env.GEMINI_API_KEY ?? env.GOOGLE_GEN_AI_KEY ?? '').trim();
}

function cleanB64(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, '');
}

const GEMINI_INLINE_IMAGE_POLICY: ImagePreflightPolicy = {
  maxBase64Bytes: 4 * 1024 * 1024,
  maxLongEdge: 2048,
  compressOversized: true,
  supportedMimeTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
};

/** Re-encode / downscale inline images so Gemini never sees corrupt or oversized blobs. */
async function normalizeGeminiInlineImage(
  base64: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | { error: string }> {
  const clean = cleanB64(base64).trim();
  if (!clean) {
    return { error: '图片数据为空，请重新上传角色设定图' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(clean, 'base64');
  } catch {
    return { error: '图片 base64 解码失败，请重新上传 PNG/JPEG' };
  }
  if (bytes.length < 32) {
    return { error: '图片数据不完整（可能因浏览器缓存配额被截断），请重新上传' };
  }

  const fitted = await fitImageToPolicy(bytes, mimeType || 'image/png', GEMINI_INLINE_IMAGE_POLICY);
  if (!fitted) {
    return { error: '图片过大或格式不支持，请换一张较小的 PNG/JPEG 后重试' };
  }

  // fitImageToPolicy may return a truncated blob when IHDR is readable but pixel data is missing.
  try {
    const maxEdge = GEMINI_INLINE_IMAGE_POLICY.maxLongEdge ?? 2048;
    const reencoded = await sharp(fitted.bytes, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { data: reencoded.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return {
      error: '图片数据损坏或不完整（大图可能被浏览器缓存截断），请重新上传角色设定图',
    };
  }
}

/** Image-gen model ids must not be used for TEXT modality (Spine prompt step). */
function resolveGeminiTextModel(requested?: string): string {
  const m = requested?.trim();
  // Vision-capable text model — do not pass image-gen ids like gemini-3-pro-image-preview.
  if (!m) return 'gemini-2.5-flash';
  if (m.includes('image')) return 'gemini-2.5-flash';
  return m;
}

async function geminiGenerateContent(
  env: Record<string, string | undefined>,
  model: string,
  payload: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const apiKey = getGeminiKey(env);
  if (!apiKey) {
    return { ok: false, error: '未配置 GEMINI_API_KEY，请在 Studio .env 中设置后重启服务' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({})) as { error?: { message?: string } };
    if (!r.ok) {
      return { ok: false, error: j.error?.message || `Gemini API 错误 (${r.status})` };
    }
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Gemini 网络请求失败' };
  }
}

async function shimGeminiMultimodalText(
  env: Record<string, string | undefined>,
  body: GeminiTextBody,
): Promise<{ success: boolean; text?: string; error?: string }> {
  const model = resolveGeminiTextModel(body.model);
  const parts: Array<Record<string, unknown>> = [];
  for (const img of body.inputImages ?? []) {
    const normalized = await normalizeGeminiInlineImage(img.base64, img.mimeType || 'image/png');
    if ('error' in normalized) return { success: false, error: normalized.error };
    parts.push({
      inlineData: { mimeType: normalized.mimeType, data: normalized.data },
    });
  }
  parts.push({ text: body.prompt });
  const result = await geminiGenerateContent(env, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT'], temperature: 1.0, maxOutputTokens: 4096 },
  });
  if (!result.ok) return { success: false, error: result.error };
  const data = result.data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) return { success: false, error: '模型未返回文本内容' };
  return { success: true, text };
}

async function shimGeminiMultimodalImage(
  env: Record<string, string | undefined>,
  body: GenerateImageBody,
): Promise<{ success: boolean; imageBase64?: string; mimeType?: string; error?: string }> {
  const model = body.model?.trim() || 'gemini-2.5-flash-image';
  const parts: Array<Record<string, unknown>> = [];
  if (body.inputImageBase64) {
    const normalized = await normalizeGeminiInlineImage(body.inputImageBase64, 'image/png');
    if ('error' in normalized) return { success: false, error: normalized.error };
    parts.push({ inlineData: { mimeType: normalized.mimeType, data: normalized.data } });
  }
  for (const img of body.inputImages ?? []) {
    const normalized = await normalizeGeminiInlineImage(img.base64, img.mimeType || 'image/png');
    if ('error' in normalized) return { success: false, error: normalized.error };
    parts.push({ inlineData: { mimeType: normalized.mimeType, data: normalized.data } });
  }
  parts.push({ text: body.prompt });
  const genConfig: Record<string, unknown> = { responseModalities: ['IMAGE'], temperature: 1.0 };
  const imgCfg: Record<string, string> = {};
  if (body.aspectRatio) imgCfg.aspectRatio = body.aspectRatio;
  if (body.imageSize) imgCfg.imageSize = body.imageSize;
  if (Object.keys(imgCfg).length > 0) genConfig.imageConfig = imgCfg;

  const result = await geminiGenerateContent(env, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: genConfig,
  });
  if (!result.ok) return { success: false, error: result.error };
  const data = result.data as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return {
          success: true,
          imageBase64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
    }
  }
  if (data.promptFeedback?.blockReason) {
    return { success: false, error: `内容被拦截: ${data.promptFeedback.blockReason}` };
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return { success: false, error: text || '模型未返回图片' };
}

function needsGeminiImageRoute(body: GenerateImageBody): boolean {
  const model = body.model?.trim() ?? '';
  return model.startsWith('gemini')
    || (body.inputImages?.length ?? 0) > 1
    || Boolean(body.aspectRatio);
}
export function createCeApiShimRouter(ctx: CeApiShimCtx): Hono {
  const app = new Hono();

  // wb-ui step-3: real component asset generation (MCP/Gemini + cutout QA)
  app.post('/ui-design/generate-assets', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    try {
      return c.json(await handleUiDesignGenerateAssetsReal(ctx, body as UiDesignGenerateAssetsBody), 200);
    } catch (e) {
      console.error('[ui-design/generate-assets] unhandled:', e);
      return c.json({
        success: false,
        error: (e as Error).message || 'UI 组件素材生成失败',
      }, 200);
    }
  });

  // ── POST /generate-image ──────────────────────────────────────────────
  // The iframe expects: { success, imageBase64, mimeType }
  // We route through ImageDispatcher (registers seedream / nano-banana /
  // azure-gpt-image / litellm-images on construction, fallback chain wired).
  app.post('/generate-image', async (c) => {
    let body: GenerateImageBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });

    const refImageBase64 = body.inputImageBase64 ?? body.inputImages?.[0]?.base64;
    const dispatcher = new ImageDispatcher(ctx.env);
    const role = body.role ?? 'concept-art';
    const requestedModel = body.model?.trim() || undefined;
    const preferredVendor = vendorForModel(requestedModel);
    try {
      const r = await dispatcher.generate(role, {
        prompt,
        size: '2k',
        refImageBase64,
        modelOverride: requestedModel,
      }, preferredVendor);
      return c.json({
        success: true,
        imageBase64: Buffer.from(r.pngBytes).toString('base64'),
        mimeType: r.mime,
        vendor: r.vendor,
        modelId: r.modelId,
        triedVendors: r.triedVendors,
      });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '图像生成失败' });
    } finally {
      dispatcher.dispose();
    }
  });

  // ── POST /gemini-text ────────────────────────────────────────────────
  // Iframe expects: { success, text }
  // Multimodal (inputImages) → 501 for now (llm-gateway.complete is text-only).
  app.post('/gemini-text', async (c) => {
    let body: GeminiTextBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });
    if (Array.isArray(body.inputImages) && body.inputImages.length > 0) {
      return c.json({
        success: false,
        error: 'multimodal /gemini-text not yet wired in studio (text-only via lib/llm-gateway). Use the /api/wb/character upload flow for vision inputs.',
      });
    }
    const messages: ChatMessage[] = [];
    if (body.system?.trim()) messages.push({ role: 'system', content: body.system });
    messages.push({ role: 'user', content: prompt });
    try {
      const r = await complete({
        model: body.model?.trim() || 'claude-opus-4-7',
        messages,
      });
      return c.json({ success: true, text: r.text, upstreamModel: r.upstreamModel });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── POST /chat ───────────────────────────────────────────────────────
  // Iframe expects: { success, text }
  app.post('/chat', async (c) => {
    let body: ChatBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ success: false, error: '缺少 messages' });
    }
    const messages: ChatMessage[] = [];
    if (body.system?.trim()) messages.push({ role: 'system', content: body.system });
    for (const m of body.messages) {
      const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      messages.push({ role, content });
    }
    try {
      const r = await complete({
        model: body.model?.trim() || 'claude-opus-4-7',
        messages,
        maxTokens: body.maxTokens,
      });
      return c.json({ success: true, text: r.text, upstreamModel: r.upstreamModel });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── wb-reel text (litellm /v1/chat/completions · 统一文本) ───────────────
  // wb-reel 原本浏览器直连 Gemini/Claude（key 被打进前端 bundle，违反密钥红线）。
  // 这两条路由让文本统一经宿主 → litellm，key 留 server；支持 jsonMode、多模态
  // （vision，image_url content parts）与 SSE 流式。
  //
  //   POST /reel-chat         { model?, system?, user, images?, jsonMode?, maxTokens?, temperature? }
  //     → { success, text, upstreamModel? }
  //   POST /reel-chat-stream  （同 body）→ text/event-stream，行格式：
  //     data: {"delta":"..."} / data: {"done":true,"full":"..."} / data: {"error":"..."}
  app.post('/reel-chat', async (c) => {
    const base = litellmChatBase();
    const key = process.env.LITELLM_PROXY_KEY ?? '';
    if (!base || !key) return c.json({ success: false, error: 'litellm 未配置（缺 LITELLM_PROXY_BASE_URL/KEY）' });
    let body: ReelChatBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const messages = buildReelChatMessages(body);
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: body.model?.trim() || DEFAULT_REEL_TEXT_MODEL,
          messages,
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(typeof body.maxTokens === 'number' ? { max_tokens: body.maxTokens } : {}),
        }),
      });
      const raw = await resp.text();
      let data: { choices?: Array<{ message?: { content?: string } }>; model?: string; error?: { message?: string } };
      try { data = JSON.parse(raw); } catch {
        return c.json({ success: false, error: `non-JSON (HTTP ${resp.status}) · ${raw.slice(0, 200)}` });
      }
      if (!resp.ok) return c.json({ success: false, error: data.error?.message ?? `HTTP ${resp.status}` });
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) return c.json({ success: false, error: '模型未返回文本' });
      return c.json({ success: true, text, upstreamModel: data.model });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── POST /reel-tts ────────────────────────────────────────────────────
  // wb-reel 角色音色 / 旁白合成。key 全程留 server，浏览器只发同源 /__ce-api__/reel-tts。
  //   POST /reel-tts  { text, voice, speed?, model? }
  //     → { success, base64, mimeType }   base64 = 音频字节；前端拼 data URL
  //
  // 路由优先级（2026-06）：
  //   ① 直连豆包（DOUBAO_TTS_*）—— **首选**。LiteLLM 代理的 key 白名单里没有
  //      TTS 模型（走 litellm 会 401），而 .env 普遍带直连豆包凭据，key 同样留 server。
  //   ② litellm /audio/speech —— 仅当代理确实开通了 TTS 模型时作兜底。
  // 两者皆未配置才报错。
  app.post('/reel-tts', async (c) => {
    if (!minimaxTtsConfigured() && !doubaoTtsConfigured() && !litellmTtsConfigured()) {
      return c.json({
        success: false,
        error: 'TTS 未配置：请在 .env 设 MINIMAX_API_KEY（直连 MiniMax），或 DOUBAO_TTS_KEY + DOUBAO_TTS_APP_ID（直连豆包），或让 LiteLLM 代理开通 TTS 模型',
      });
    }
    let body: { text?: string; voice?: string; speed?: number; model?: string };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const text = (body.text ?? '').trim();
    const voice = (body.voice ?? '').trim();
    if (!text) return c.json({ success: false, error: 'empty text' });
    if (!voice) return c.json({ success: false, error: 'empty voice' });

    const speed = typeof body.speed === 'number' ? body.speed : undefined;
    const errors: string[] = [];

    // ① litellm `doubao-tts` 优先（2026-06 代理已开通，影游统一走 litellm；
    //    音色用豆包 BV* 编码，实测各编码产出不同音色）。
    if (litellmTtsConfigured()) {
      try {
        const { bytes, mime } = await createLitellmSpeech({
          input: text,
          voice,
          model: body.model,
          speed,
        });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) {
        errors.push(`litellm: ${(e as Error).message}`);
      }
    }
    // ② 直连 MiniMax 兜底（litellm 不可用时；注意 voice 需用 MiniMax voice_id）
    if (minimaxTtsConfigured()) {
      try {
        const { bytes, mime } = await createMinimaxSpeech({ input: text, voice, speed, model: body.model });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) {
        errors.push(`minimax: ${(e as Error).message}`);
      }
    }
    // ③ 直连豆包兜底（账号开通后自动启用）
    if (doubaoTtsConfigured()) {
      try {
        const { bytes, mime } = await createDoubaoSpeech({ input: text, voice, speed });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) {
        errors.push(`doubao: ${(e as Error).message}`);
      }
    }
    return c.json({ success: false, error: errors.join(' · ') || 'TTS 合成失败' });
  });

  // ── POST /reel-music ──────────────────────────────────────────────────
  // wb-reel 场景 BGM 生成（MiniMax music_generation 直连）。key 留 server。
  //   POST /reel-music  { prompt?, lyrics?, isInstrumental?, lyricsOptimizer?, model?, audioSetting? }
  //     → { success, base64, mimeType, durationMs?, sampleRate?, channel?, bitrate?, fileSizeBytes?, model? }
  //   注意：同步阻塞接口，整曲常需 60–150s，前端走宿主网关时不要设短超时。
  app.post('/reel-music', async (c) => {
    if (!minimaxMusicConfigured()) {
      return c.json({
        success: false,
        error: 'BGM 未配置：请在 .env 设 MINIMAX_MUSIC_KEY（直连 MiniMax 音乐）',
      });
    }
    let body: {
      prompt?: string;
      lyrics?: string;
      isInstrumental?: boolean;
      lyricsOptimizer?: boolean;
      model?: string;
      audioSetting?: {
        sampleRate?: 16000 | 24000 | 32000 | 44100;
        bitrate?: 32000 | 64000 | 128000 | 256000;
        format?: 'mp3' | 'wav' | 'pcm';
      };
    };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    if (!body.prompt?.trim() && !body.lyrics?.trim() && !body.lyricsOptimizer) {
      return c.json({ success: false, error: 'prompt / lyrics 至少给一个' });
    }
    try {
      const r = await createMinimaxMusic({
        prompt: body.prompt,
        lyrics: body.lyrics,
        isInstrumental: body.isInstrumental,
        lyricsOptimizer: body.lyricsOptimizer,
        model: body.model,
        audioSetting: body.audioSetting,
      });
      return c.json({
        success: true,
        base64: r.bytes.toString('base64'),
        mimeType: r.mime,
        model: r.model,
        traceId: r.traceId,
        durationMs: r.durationMs,
        sampleRate: r.sampleRate,
        channel: r.channel,
        bitrate: r.bitrate,
        fileSizeBytes: r.fileSizeBytes,
      });
    } catch (e) {
      return c.json({ success: false, error: `minimax-music: ${(e as Error).message}` });
    }
  });

  app.post('/reel-chat-stream', async (c) => {
    const base = litellmChatBase();
    const key = process.env.LITELLM_PROXY_KEY ?? '';
    const sse = (obj: unknown): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
    const sseHeaders = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    };
    if (!base || !key) {
      return new Response(sse({ error: 'litellm 未配置' }), { status: 200, headers: sseHeaders });
    }
    let body: ReelChatBody;
    try { body = await c.req.json(); } catch {
      return new Response(sse({ error: 'invalid JSON body' }), { status: 200, headers: sseHeaders });
    }
    const messages = buildReelChatMessages(body);
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: body.model?.trim() || DEFAULT_REEL_TEXT_MODEL,
          messages,
          stream: true,
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(typeof body.maxTokens === 'number' ? { max_tokens: body.maxTokens } : {}),
        }),
      });
    } catch (e) {
      return new Response(sse({ error: (e as Error).message }), { status: 200, headers: sseHeaders });
    }
    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      return new Response(sse({ error: `HTTP ${upstream.status} · ${errText.slice(0, 200)}` }), { status: 200, headers: sseHeaders });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let full = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta) {
                  full += delta;
                  controller.enqueue(sse({ delta }));
                }
              } catch { /* skip non-JSON keepalive lines */ }
            }
          }
          controller.enqueue(sse({ done: true, full }));
        } catch (e) {
          controller.enqueue(sse({ error: (e as Error).message }));
        } finally {
          try { reader.releaseLock(); } catch { /* noop */ }
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers: sseHeaders });
  });

  // ── wb-reel image (litellm gpt-image-2 · 全部走 litellm) ─────────────────
  // 固定 model=gpt-image-2（作者约束「只用 image2」）。无参考图走
  // /v1/images/generations；≥1 参考图走 /v1/images/edits（多图编辑，保锚点一致）。
  //   POST /reel-image  { prompt, size?, referenceImagesB64?[] }
  //     → { success, imageBase64, mimeType, modelId }
  app.post('/reel-image', async (c) => {
    if (!litellmImageConfigured()) {
      return c.json({ success: false, error: 'litellm 图像未配置（缺 LITELLM_PROXY_BASE_URL/KEY）' });
    }
    let body: { prompt?: string; size?: string; referenceImagesB64?: string[] };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });
    try {
      const r = await generateReelImage({
        prompt,
        size: body.size,
        referenceImagesB64: Array.isArray(body.referenceImagesB64) ? body.referenceImagesB64 : [],
      });
      return c.json({ success: true, imageBase64: r.b64, mimeType: r.mime, modelId: r.modelId });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '图像生成失败' });
    }
  });

  // ── wb-reel video (litellm /v1/videos · async task) ─────────────────────
  // Three-step contract mirrors the OpenAI Sora shape, but the iframe never
  // sees the litellm key: the host creates the task, polls status, downloads
  // the completed mp4 and re-serves it same-origin.
  //
  //   POST /generate-video  { prompt, model?, seconds?, size?,
  //                           inputReferenceDataUrl?, generateAudio? }
  //     → { success, taskId }
  //   GET  /video-status?taskId=...
  //     → { success, status, videoUrl?, error? }   (videoUrl set when completed)
  //   GET  /video-file/:id   → streams the saved mp4
  app.post('/generate-video', async (c) => {
    // 视频网关优先级：直连火山方舟（ARK_VIDEO_KEY，支持 doubao-seedance-2-0 的
    // 多图参考 R2V：角色定妆照 + 场景同时作为 reference_image）> litellm 代理
    // （只能单图当首帧、丢多图）。两者都没配才报错。
    const useArk = arkVideoConfigured();
    if (!useArk && !litellmVideoConfigured()) {
      return c.json({
        success: false,
        error: '视频网关未配置（缺 ARK_VIDEO_KEY 或 LITELLM_PROXY_BASE_URL/KEY）',
      });
    }
    let body: {
      prompt?: string;
      model?: string;
      seconds?: number | string;
      size?: string;
      inputReferenceDataUrl?: string;
      generateAudio?: boolean;
      // Seedance 原生 knobs（2026-06）—— 放进 litellm extra_body 逐字透传
      mode?: string;
      resolution?: string;
      ratio?: string;
      imageWithRoles?: Array<{ role?: string; url?: string }>;
      referenceVideoDataUrl?: string;
      referenceAudioDataUrl?: string;
      watermark?: boolean;
    };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });

    // ── 直连火山方舟（首选）：完整 content[] 多图带 role，真正支持
    //    角色定妆照 + 场景 同时作为 reference_image（R2V）。 ──
    if (useArk) {
      try {
        const { id } = await createArkVideoTask({
          prompt,
          model: body.model,
          seconds: body.seconds,
          resolution: body.resolution,
          ratio: body.ratio,
          generateAudio: body.generateAudio,
          watermark: body.watermark,
          imageWithRoles: body.imageWithRoles,
          inputReferenceDataUrl: body.inputReferenceDataUrl,
          referenceVideoDataUrl: body.referenceVideoDataUrl,
          referenceAudioDataUrl: body.referenceAudioDataUrl,
        });
        return c.json({ success: true, taskId: id });
      } catch (e) {
        return c.json({ success: false, error: (e as Error).message || '视频任务创建失败' });
      }
    }

    try {
      // Seedance 原生 knobs → extra_body 逐字透传（代理侧适配器决定是否生效）。
      const extraBody: Record<string, unknown> = {};
      if (typeof body.generateAudio === 'boolean') extraBody.generate_audio = body.generateAudio;
      if (typeof body.watermark === 'boolean') extraBody.watermark = body.watermark;
      if (body.mode) extraBody.mode = body.mode;
      if (body.resolution) extraBody.resolution = body.resolution;
      if (body.ratio) extraBody.ratio = body.ratio;
      const roleImgs = Array.isArray(body.imageWithRoles)
        ? body.imageWithRoles.filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
        : [];
      if (roleImgs.length > 0) extraBody.image_with_roles = roleImgs;
      if (body.referenceVideoDataUrl) extraBody.reference_video = body.referenceVideoDataUrl;
      if (body.referenceAudioDataUrl) extraBody.reference_audio = body.referenceAudioDataUrl;
      const { id } = await createLitellmVideoTask({
        prompt,
        model: body.model,
        seconds: body.seconds,
        size: body.size,
        inputReferenceDataUrl: body.inputReferenceDataUrl,
        extraBody,
      });
      return c.json({ success: true, taskId: id });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '视频任务创建失败' });
    }
  });

  app.get('/video-status', async (c) => {
    const taskId = c.req.query('taskId') || '';
    if (!taskId) return c.json({ success: false, error: '缺少 taskId' });
    try {
      const hash = createHash('sha1').update(taskId).digest('hex');
      const filePath = resolve(reelVideoDir(ctx), `${hash}.mp4`);
      // Already downloaded → return cached URL without re-hitting the gateway.
      if (existsSync(filePath)) {
        return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
      }
      // 按 task id 前缀路由：ARK(cgt-...) 走直连方舟；其余走 litellm。
      if (isArkTaskId(taskId)) {
        const st = await getArkVideoStatus(taskId);
        if (st.status === 'completed') {
          if (!st.videoUrl) {
            return c.json({ success: true, status: 'failed', error: 'ARK 任务完成但缺少 video_url' });
          }
          const { bytes } = await downloadArkVideoContent(st.videoUrl);
          ensureDir(reelVideoDir(ctx));
          writeFileSync(filePath, bytes);
          return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
        }
        if (st.status === 'failed') {
          return c.json({ success: true, status: 'failed', error: st.error || '视频任务失败' });
        }
        return c.json({ success: true, status: st.status });
      }
      const st = await getLitellmVideoStatus(taskId);
      if (st.status === 'completed') {
        const { bytes } = await downloadLitellmVideoContent(taskId);
        ensureDir(reelVideoDir(ctx));
        writeFileSync(filePath, bytes);
        return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
      }
      if (st.status === 'failed') {
        return c.json({ success: true, status: 'failed', error: st.error || '视频任务失败' });
      }
      return c.json({ success: true, status: st.status });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '视频状态查询失败' });
    }
  });

  app.get('/video-file/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[a-f0-9]{40}$/.test(id)) return c.json({ error: 'invalid id' }, 400);
    const filePath = resolve(reelVideoDir(ctx), `${id}.mp4`);
    if (!existsSync(filePath)) return c.json({ error: 'not found' }, 404);
    const data = readFileSync(filePath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'cache-control': 'public, max-age=86400' },
    });
  });

  // ── Face mask（上传 Seedance/Kling 前的人脸打码）─────────────────────
  // 2026-06：本机 Python sidecar（YOLOv8 + 马赛克）已移除——它依赖 torch/opencv，
  // 不在工程允许的语言栈内，且仓内并无模型权重（实际长期处于透传状态）。
  //
  // 现行为：本路由默认**同进程透传**（返回 success:false → 前端 faceMaskTool
  // 优雅降级为「原图直传」，绝不阻断生成）。
  //
  // 扩展点：若日后接入纯 TS 打码服务，只需设 FACE_MASK_SERVICE_URL 指向一个
  // 暴露 `POST /mask { image, mode?, halfSide? } → { success, image, faces }`
  // 的 HTTP 服务，本路由即会反代过去（契约与旧 sidecar 一致）。
  //   POST /face-mask  { image, mode?, halfSide?, confidence?, padding?, targetBlocks? }
  //     → { success, image, faces }   |   { success: false, error }
  app.post('/face-mask', async (c) => {
    let body: {
      image?: string;
      mode?: string;
      halfSide?: string;
      confidence?: number;
      padding?: number;
      targetBlocks?: number;
    };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const image = body.image?.trim();
    if (!image) return c.json({ success: false, error: '缺少 image' });

    const external = (
      ctx.env?.FACE_MASK_SERVICE_URL ||
      process.env.FACE_MASK_SERVICE_URL ||
      ''
    ).replace(/\/+$/, '');
    // 未配置外部打码服务 → 直接透传（不打码、不报错地继续生成）。
    if (!external) {
      return c.json({ success: false, error: 'face-mask 已停用（无打码服务，透传原图）' });
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      let resp: Response;
      try {
        resp = await fetch(`${external}/mask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            image,
            mode: body.mode,
            halfSide: body.halfSide,
            confidence: body.confidence,
            padding: body.padding,
            targetBlocks: body.targetBlocks,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const data = (await resp.json().catch(() => ({}))) as {
        success?: boolean; image?: string; faces?: number; error?: string;
      };
      if (!resp.ok || !data.success || !data.image) {
        return c.json({ success: false, error: data.error || `打码服务返回 HTTP ${resp.status}` });
      }
      return c.json({ success: true, image: data.image, faces: data.faces ?? 0 });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '打码服务不可用' });
    }
  });

  // ── Character render config ──────────────────────────────────────────
  // GET returns saved JSON or '{}'; POST writes verbatim body to disk.
  // Lives at <shimRoot>/character-render.json (not under any game).
  app.get('/character-render-config', (c) => {
    const p = resolve(shimRoot(ctx), 'character-render.json');
    if (!existsSync(p)) return c.body('{}', 200, { 'content-type': 'application/json' });
    try {
      return c.body(readFileSync(p, 'utf-8'), 200, { 'content-type': 'application/json' });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message }, 500);
    }
  });
  app.post('/character-render-config', async (c) => {
    try {
      const raw = await c.req.text();
      ensureDir(shimRoot(ctx));
      writeFileSync(resolve(shimRoot(ctx), 'character-render.json'), raw, 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Scene settings + default settings ────────────────────────────────
  app.post('/save-scene-settings', async (c) => {
    try {
      const body = await c.req.json();
      const p = resolve(shimRoot(ctx), 'scene-settings.json');
      ensureDir(shimRoot(ctx));
      writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });
  app.post('/save-default-settings', async (c) => {
    try {
      const body = await c.req.json();
      const p = resolve(shimRoot(ctx), 'default-settings.json');
      ensureDir(shimRoot(ctx));
      writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Publish character (legacy CHARACTER_EXPORT_DIR target) ───────────
  app.post('/publish-character', async (c) => {
    try {
      const body = await c.req.json() as {
        characterId?: string;
        manifest?: unknown;
        files?: Record<string, string>;
      };
      if (!isSafeId(body.characterId)) {
        return c.json({ success: false, error: 'Invalid characterId' });
      }
      if (!body.manifest || typeof body.manifest !== 'object') {
        return c.json({ success: false, error: 'Missing manifest' });
      }
      const targetDir = resolve(characterExportDir(ctx), body.characterId);
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      ensureDir(targetDir);
      const fileCount = writeFilesUnder(targetDir, body.files ?? {});
      writeFileSync(
        resolve(targetDir, 'character.manifest.json'),
        JSON.stringify(body.manifest, null, 2),
        'utf-8',
      );
      console.log(`[ce-api-shim] publish-character: ${body.characterId} → ${targetDir} (${fileCount + 1} files)`);
      return c.json({ success: true, dir: targetDir, fileCount: fileCount + 1 });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Publish to workspace game ────────────────────────────────────────
  // Target: <projectRoot>/.forgeax/games/<gameId>/public/assets/art/characters/<slot>/
  app.post('/publish-to-workspace-game', async (c) => {
    try {
      const body = await c.req.json() as {
        gameId?: string;
        characterId?: string;
        manifest?: unknown;
        files?: Record<string, string>;
      };
      if (!isSafeId(body.gameId)) return c.json({ success: false, error: 'Invalid gameId' });
      if (!isSafeId(body.characterId)) return c.json({ success: false, error: 'Invalid characterId' });
      if (!body.manifest || typeof body.manifest !== 'object') {
        return c.json({ success: false, error: 'Missing manifest' });
      }
      const gameRoot = resolve(workspaceGamesDir(ctx), body.gameId);
      if (!existsSync(gameRoot)) {
        return c.json({ success: false, error: `Game not found: ${body.gameId} (in ${workspaceGamesDir(ctx)})` });
      }
      const targetDir = resolve(gameRoot, 'public/assets/art/characters', body.characterId);
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      ensureDir(targetDir);
      const fileCount = writeFilesUnder(targetDir, body.files ?? {});
      writeFileSync(
        resolve(targetDir, 'character.manifest.json'),
        JSON.stringify(body.manifest, null, 2),
        'utf-8',
      );
      console.log(`[ce-api-shim] publish-to-workspace-game: ${body.gameId}/${body.characterId} → ${targetDir} (${fileCount + 1} files)`);
      return c.json({ success: true, dir: targetDir, fileCount: fileCount + 1 });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Merge skills (VFX → existing manifest) ───────────────────────────
  app.post('/merge-skills-to-workspace-game', async (c) => {
    try {
      const body = await c.req.json() as {
        gameId?: string;
        characterId?: string;
        skills?: Array<{ slotId?: string; actionId?: string }>;
      };
      if (!isSafeId(body.gameId)) return c.json({ success: false, error: 'Invalid gameId' });
      if (!isSafeId(body.characterId)) return c.json({ success: false, error: 'Invalid characterId' });
      if (!Array.isArray(body.skills)) return c.json({ success: false, error: 'Missing skills[]' });

      const charDir = resolve(workspaceGamesDir(ctx), body.gameId, 'public/assets/art/characters', body.characterId);
      const manifestPath = resolve(charDir, 'character.manifest.json');
      if (!existsSync(manifestPath)) {
        return c.json({
          success: false,
          error: `Character not found: ${body.characterId} in game ${body.gameId}. 请先用「导入到游戏作为主角」发布一次。`,
        });
      }
      let manifest: { actions?: Array<{ id?: string }>; skills?: unknown[] };
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); }
      catch (e) { return c.json({ success: false, error: `Failed to parse manifest: ${(e as Error).message}` }); }
      if (!Array.isArray(manifest.actions)) {
        return c.json({ success: false, error: 'Existing manifest has no actions[]' });
      }
      const actionIds = new Set(manifest.actions.map((a) => String(a?.id ?? '')));
      const existing: Array<{ slotId?: string }> = Array.isArray(manifest.skills) ? manifest.skills as Array<{ slotId?: string }> : [];
      const bySlotId = new Map<string, unknown>();
      for (const s of existing) {
        if (s && typeof s.slotId === 'string') bySlotId.set(s.slotId, s);
      }
      const applied: unknown[] = [];
      const skipped: Array<{ slotId: string; reason: string }> = [];
      for (const raw of body.skills) {
        if (!raw || typeof raw !== 'object') continue;
        const slotId = String(raw.slotId ?? '');
        const actionId = String(raw.actionId ?? '');
        if (!slotId) { skipped.push({ slotId: '?', reason: 'missing slotId' }); continue; }
        if (!actionId || !actionIds.has(actionId)) {
          skipped.push({ slotId, reason: `actionId "${actionId}" not in manifest` });
          continue;
        }
        bySlotId.set(slotId, raw);
        applied.push(raw);
      }
      const merged = {
        ...manifest,
        skills: Array.from(bySlotId.values()),
        exportedAt: Date.now(),
      };
      writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf-8');
      return c.json({
        success: true,
        dir: charDir,
        skillsApplied: applied.length,
        skillsSkipped: skipped.length,
        skippedDetail: skipped,
      });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Spine session persistence ────────────────────────────────────────
  app.post('/save-spine-session', async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const currentDir = join(spineDir(ctx), 'current');
      saveSpineSessionTo(body, currentDir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const historySlot = join(spineHistoryDir(ctx), ts);
      saveSpineSessionTo(body, historySlot);
      pruneSpineHistory(spineHistoryDir(ctx));
      return c.json({ success: true, historySlot: ts });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/load-spine-session', (c) => {
    try {
      const slot = c.req.query('slot');
      const dir = slot ? join(spineHistoryDir(ctx), slot) : join(spineDir(ctx), 'current');
      const data = loadSpineSessionFrom(dir);
      if (data) return c.json({ success: true, session: data });
      return c.json({ success: false, error: 'No saved session' });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/list-spine-sessions', (c) => {
    try {
      ensureDir(spineHistoryDir(ctx));
      const dirs = readdirSync(spineHistoryDir(ctx))
        .filter((d) => existsSync(join(spineHistoryDir(ctx), d, 'session.json')))
        .sort().reverse();
      const entries = dirs.map((d) => {
        try {
          const meta = JSON.parse(readFileSync(join(spineHistoryDir(ctx), d, 'session.json'), 'utf-8'));
          return {
            slot: d,
            timestamp: meta.timestamp,
            profession: meta.profession,
            activeTab: meta.activeTab,
            hasThumbnail: existsSync(join(spineHistoryDir(ctx), d, 'character.png')),
            hasExplosion: !!meta.hasExplosionImage,
            partsCount: (meta.partRegionsMeta || []).filter((p: { width?: number }) => (p.width ?? 0) > 0).length,
          };
        } catch { return null; }
      }).filter(Boolean);
      return c.json({ success: true, sessions: entries });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/spine-session-thumbnail', (c) => {
    const slot = c.req.query('slot');
    if (!slot) return c.json({ error: 'Missing slot' }, 400);
    const imgPath = join(spineHistoryDir(ctx), slot, 'character.png');
    if (!existsSync(imgPath)) return c.json({ error: 'No thumbnail' }, 404);
    const data = readFileSync(imgPath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    });
  });

  // ── Workspace games listing ──────────────────────────────────────────
  app.get('/list-workspace-games', (c) => {
    const root = workspaceGamesDir(ctx);
    if (!existsSync(root)) return c.json({ success: true, root, games: [] });
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      const games: Array<{ gameId: string; hasPlayerSlot: boolean }> = [];
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || !isSafeId(ent.name)) continue;
        const gameRoot = resolve(root, ent.name);
        const looksLikeGame = existsSync(resolve(gameRoot, 'package.json'))
          || existsSync(resolve(gameRoot, 'public'))
          || existsSync(resolve(gameRoot, 'forge.json'));
        if (!looksLikeGame) continue;
        const hasPlayerSlot = existsSync(
          resolve(gameRoot, 'public/assets/art/characters/player/character.manifest.json'),
        );
        games.push({ gameId: ent.name, hasPlayerSlot });
      }
      return c.json({ success: true, root, games });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/workspace-game-manifest', (c) => {
    const gameId = c.req.query('gameId') || '';
    const characterId = c.req.query('characterId') || '';
    if (!isSafeId(gameId) || !isSafeId(characterId)) {
      return c.json({ success: false, error: 'invalid gameId/characterId' });
    }
    const p = resolve(workspaceGamesDir(ctx), gameId, 'public/assets/art/characters', characterId, 'character.manifest.json');
    if (!existsSync(p)) return c.json({ success: false, error: 'manifest not found' });
    try {
      return c.json({ success: true, manifest: JSON.parse(readFileSync(p, 'utf-8')) });
    } catch (e) {
      return c.json({ success: false, error: `parse failed: ${(e as Error).message}` });
    }
  });

  app.get('/list-workspace-game-npcs', (c) => {
    const gameId = c.req.query('gameId') || '';
    if (!isSafeId(gameId)) return c.json({ success: false, error: 'invalid gameId', npcs: [] });
    const gameRoot = resolve(workspaceGamesDir(ctx), gameId);
    const npcsJsonPath = resolve(gameRoot, 'public/npcs.json');
    if (!existsSync(npcsJsonPath)) {
      return c.json({
        success: false,
        error: '游戏里没有 public/npcs.json —— 无法自动发现 NPC 槽位。',
        npcs: [],
      });
    }
    try {
      const parsed = JSON.parse(readFileSync(npcsJsonPath, 'utf-8'));
      const raw = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
      const charDirRoot = resolve(gameRoot, 'public/assets/art/characters');
      const npcs = raw
        .filter((n: { manifestId?: unknown }) => n && typeof n.manifestId === 'string' && isSafeId(n.manifestId))
        .map((n: { kind?: string; tag?: unknown; name?: unknown; manifestId: string }) => ({
          kind: n.kind === 'civilian_pool' ? 'civilian_pool' : 'npc',
          tag: String(n.tag ?? ''),
          name: String(n.name ?? n.tag ?? n.manifestId),
          manifestId: n.manifestId,
          hasManifest: existsSync(resolve(charDirRoot, n.manifestId, 'character.manifest.json')),
        }));
      return c.json({ success: true, npcs });
    } catch (e) {
      return c.json({ success: false, error: `parse npcs.json failed: ${(e as Error).message}` });
    }
  });

  // ── Deferred endpoints (503) ─────────────────────────────────────────
  // Each returns success:false so the iframe's existing fail-toast picks it
  // up. The error message names the missing dependency so the user can flag
  // it to us as we wire each one in.
  const deferred: Record<string, string> = {
    '/video-generate':        'Kling video pipeline not wired in studio. Needs KLING_AK/SK + monster-pipeline.',
    '/analyze-ultimate':      'MCP analyze-ultimate not running in studio.',
    '/magic-prompt':          'MCP magic-prompt server not running in studio.',
    '/remove-bg':             'remove-bg dependency (rembg / ComfyUI) not running in studio.',
    '/enhance-prompt':        'MCP enhance-prompt server not running in studio.',
    '/pixelart':              'MCP pixelart server not running in studio.',
    '/character-turnaround':  'character-turnaround needs MCP pixelart server.',
    '/video-query':           'Kling video pipeline not wired in studio.',
    '/video-proxy':           'Kling video pipeline not wired in studio.',
  };
  for (const [path, reason] of Object.entries(deferred)) {
    app.all(path, async (c) => {
      // Match the iframe envelope so frontend renders the message inline.
      const known = reason;
      try { await c.req.text(); } catch { /* tolerate */ }
      return c.json({ success: false, error: known, deferred: true });
    });
  }

  // Monster pipeline (Python Flask on MONSTER_BACKEND_HOST:5000) is not wired
  // in the studio host. Returning a 503 envelope lets the iframe show the
  // friendly error instead of choking on a network failure.
  app.all('/monster/*', async (c) => {
    try { await c.req.text(); } catch { /* tolerate */ }
    return c.json({
      success: false,
      error: 'Monster pipeline (Python Flask) is not wired in studio host. Start it via packages/marketplace/plugins/wb-character/server/monster-pipeline/ if needed.',
      deferred: true,
    });
  });

  return app;
}

// ── helpers ────────────────────────────────────────────────────────────

function writeFilesUnder(targetDir: string, files: Record<string, string>): number {
  let fileCount = 0;
  for (const [relPath, b64] of Object.entries(files)) {
    if (typeof relPath !== 'string' || relPath.includes('..') || relPath.startsWith('/')) {
      throw new Error(`Illegal file path: ${relPath}`);
    }
    if (typeof b64 !== 'string') continue;
    const abs = resolve(targetDir, relPath);
    if (!abs.startsWith(targetDir + '/') && abs !== targetDir) {
      throw new Error(`Path escapes target dir: ${relPath}`);
    }
    ensureDir(resolve(abs, '..'));
    const match = b64.match(/^data:[^;]+;base64,(.+)$/);
    const raw = match ? match[1] : b64;
    writeFileSync(abs, Buffer.from(raw, 'base64'));
    fileCount++;
  }
  return fileCount;
}

interface SpineSessionBody {
  profession?: unknown; characterDescription?: unknown;
  activeTab?: unknown; exportPath?: unknown;
  bindingJson?: unknown; bindingVersion?: unknown;
  timestamp?: number;
  characterImage?: string; explosionImage?: string;
  partRegions?: Array<{ id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; imageData?: string }>;
  attachmentImages?: Record<string, string>;
  animations?: Record<string, unknown>;
}

function saveSpineSessionTo(body: SpineSessionBody, slotDir: string): void {
  ensureDir(slotDir);
  const partsDir = join(slotDir, 'parts');
  ensureDir(partsDir);

  const meta: {
    profession?: unknown; characterDescription?: unknown;
    activeTab?: unknown; exportPath?: unknown;
    bindingJson?: unknown; bindingVersion?: unknown;
    timestamp: number;
    partRegionsMeta: Array<{ id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; hasImage?: boolean }>;
    hasCharacterImage: boolean; hasExplosionImage: boolean;
    attachmentKeys: string[]; animationKeys: string[];
    animations?: Record<string, unknown>;
  } = {
    profession: body.profession,
    characterDescription: body.characterDescription,
    activeTab: body.activeTab,
    exportPath: body.exportPath,
    bindingJson: body.bindingJson,
    bindingVersion: body.bindingVersion,
    timestamp: body.timestamp ?? Date.now(),
    partRegionsMeta: [],
    hasCharacterImage: false,
    hasExplosionImage: false,
    attachmentKeys: [],
    animationKeys: [],
  };

  if (body.characterImage) {
    b64ToFile(body.characterImage, join(slotDir, 'character.png'));
    meta.hasCharacterImage = true;
  }
  if (body.explosionImage) {
    b64ToFile(body.explosionImage, join(slotDir, 'explosion.png'));
    meta.hasExplosionImage = true;
  }

  if (Array.isArray(body.partRegions)) {
    for (const r of body.partRegions) {
      const partMeta: { id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; hasImage?: boolean } = {
        id: r.id, name: r.name, x: r.x, y: r.y, width: r.width, height: r.height,
      };
      if (r.imageData && (r.width ?? 0) > 0) {
        b64ToFile(r.imageData, join(partsDir, `${r.id}.png`));
        partMeta.hasImage = true;
      }
      meta.partRegionsMeta.push(partMeta);
    }
  }

  if (body.attachmentImages && typeof body.attachmentImages === 'object') {
    for (const [key, dataUrl] of Object.entries(body.attachmentImages)) {
      b64ToFile(dataUrl, join(slotDir, `attach_${key}.png`));
      meta.attachmentKeys.push(key);
    }
  }

  if (body.animations && typeof body.animations === 'object') {
    meta.animations = body.animations;
    meta.animationKeys = Object.keys(body.animations);
  }

  writeFileSync(join(slotDir, 'session.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

function loadSpineSessionFrom(slotDir: string): Record<string, unknown> | null {
  const metaPath = join(slotDir, 'session.json');
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  const result: Record<string, unknown> = {
    profession: meta.profession,
    characterDescription: meta.characterDescription,
    activeTab: meta.activeTab,
    exportPath: meta.exportPath,
    bindingJson: meta.bindingJson,
    bindingVersion: meta.bindingVersion,
    timestamp: meta.timestamp,
    characterImage: null,
    explosionImage: null,
    partRegions: [] as Array<Record<string, unknown>>,
    attachmentImages: {} as Record<string, string>,
    animations: meta.animations ?? {},
  };
  if (meta.hasCharacterImage) result.characterImage = fileToB64(join(slotDir, 'character.png'));
  if (meta.hasExplosionImage) result.explosionImage = fileToB64(join(slotDir, 'explosion.png'));
  const partsDir = join(slotDir, 'parts');
  if (Array.isArray(meta.partRegionsMeta)) {
    for (const pm of meta.partRegionsMeta) {
      const region: Record<string, unknown> = {
        id: pm.id, name: pm.name, x: pm.x, y: pm.y, width: pm.width, height: pm.height, imageData: '',
      };
      if (pm.hasImage) region.imageData = fileToB64(join(partsDir, `${pm.id}.png`)) || '';
      (result.partRegions as Array<Record<string, unknown>>).push(region);
    }
  }
  if (Array.isArray(meta.attachmentKeys)) {
    for (const key of meta.attachmentKeys) {
      const data = fileToB64(join(slotDir, `attach_${key}.png`));
      if (data) (result.attachmentImages as Record<string, string>)[key] = data;
    }
  }
  return result;
}

function pruneSpineHistory(historyRoot: string): void {
  ensureDir(historyRoot);
  const dirs = readdirSync(historyRoot)
    .filter((d) => existsSync(join(historyRoot, d, 'session.json')))
    .sort().reverse();
  for (const dir of dirs.slice(MAX_SPINE_HISTORY)) {
    try { rmSync(join(historyRoot, dir), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
