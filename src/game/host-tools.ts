/** gameHostTools — the studio shell's game-domain host tools, injected into the
 *  orchestration layer via the `HostToolSpec` seam (Stage A §3 / P1-7).
 *  `list_games` / `query_world` / `capture_frame` are declared here so the cli
 *  layer remains generic.
 *
 *  Execution uses two host-tool entry points (host-tool-bridge / `:sid/kernel-tool`)
 *  after the trust gate calls `run(args, ctx)`. Perception tools use
 *  `ctx.perception` to read the live preview and return `{ unavailable }` when
 *  the UI is not connected.
 *
 *  The leased-kernel path still has a local cli mirror; this seam covers the
 *  forgeax-core native path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HostToolSpec, HostToolRunCtx } from '@forgeax/orchestrator/orchestration-seams';
import { editorGatewayHostTools } from './editor-gateway-host-tools';
import type { CarrierGameplayAdapter } from './carrier-gameplay-adapter';
import { parseGameplayOperation } from './gameplay-operation-contract';

const gameplayScopeSchema = {
  type: 'object',
  required: ['projectId', 'gameId'],
  properties: {
    projectId: { type: 'string', minLength: 1 },
    gameId: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const gameplayInputActionSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'key', 'phase'],
      properties: {
        type: { const: 'key' },
        key: { type: 'string', minLength: 1 },
        phase: { enum: ['down', 'up'] },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['type', 'x', 'y'],
      properties: {
        type: { const: 'pointer' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { enum: ['left', 'middle', 'right'] },
      },
      additionalProperties: false,
    },
  ],
} as const;

const gameplayArtifactSchema = {
  type: 'object',
  required: ['dataUrl', 'bytes', 'provenance'],
  properties: {
    dataUrl: { type: 'string', minLength: 1 },
    bytes: { type: 'number', minimum: 1 },
    provenance: {
      type: 'object',
      required: ['runtimeId', 'scope', 'pageIdentity', 'canvasIdentity', 'rendererGeneration'],
      properties: {
        runtimeId: { type: 'string', minLength: 1 },
        scope: gameplayScopeSchema,
        pageIdentity: { type: 'string', minLength: 1 },
        canvasIdentity: { type: 'string', minLength: 1 },
        rendererGeneration: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const GAMEPLAY_INPUT_SCHEMA = {
  oneOf: [
    ...(['play', 'gameplayStop', 'capture'] as const).map((operation) => ({
      type: 'object',
      required: ['operation', 'scope'],
      properties: { operation: { const: operation }, scope: gameplayScopeSchema },
      additionalProperties: false,
    })),
    {
      type: 'object',
      required: ['operation', 'scope', 'action'],
      properties: { operation: { const: 'input' }, scope: gameplayScopeSchema, action: gameplayInputActionSchema },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['operation', 'scope', 'query'],
      properties: { operation: { const: 'query' }, scope: gameplayScopeSchema, query: { type: 'string' } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['operation', 'scope', 'artifact'],
      properties: { operation: { const: 'reveal' }, scope: gameplayScopeSchema, artifact: gameplayArtifactSchema },
      additionalProperties: false,
    },
  ],
} as const;

/** List workspace games from the current and legacy roots. */
function listGames(projectRoot: string): { count: number; games: string[] } {
  const out: string[] = [];
  for (const base of [join(projectRoot, '.forgeax/games'), join(projectRoot, 'games')]) {
    if (!existsSync(base)) continue;
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) out.push(e.name);
      }
    } catch {
      /* unreadable dir → skip */
    }
  }
  const games = [...new Set(out)];
  return { count: games.length, games };
}

export function gameHostTools(): HostToolSpec[] {
  return [
    {
      name: 'list_games',
      description: 'List the game projects in this forgeax workspace. Returns { count, games }.',
      inputSchema: { type: 'object', properties: {} },
      run: (_args, ctx: HostToolRunCtx) => listGames(ctx.projectRoot),
    },
    {
      // Read live game facts; the model remains the judge of structure and invariants.
      name: 'query_world',
      description:
        "Query the RUNNING game's live world for ground truth: a structural ECS snapshot { entityCount, archetypes:[{componentNames, entityCount}], activeComponents, systems, resourceKeys }. Use it to VERIFY what the game actually contains/does (after writing code) instead of guessing. Data only — you are the judge.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args, ctx: HostToolRunCtx) =>
        ctx.perception ? ctx.perception('world', args?.query) : { unavailable: true, reason: 'no perception channel' },
    },
    {
      name: 'capture_frame',
      description:
        "Capture the running editor-viewport Play surface's current rendered frame as a PNG data URL (best-effort; may be blank on some GPUs — judge by structure/invariants, not pixels). Returns { dataUrl, bytes }.",
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, ctx: HostToolRunCtx) => {
        if (!ctx.perception) return { unavailable: true, reason: 'no perception channel' };
        const snap = await ctx.perception('frame');
        const dataUrl =
          snap && typeof snap === 'object' && typeof (snap as { dataUrl?: unknown }).dataUrl === 'string'
            ? (snap as { dataUrl: string }).dataUrl
            : '';
        if (!dataUrl) {
          const reason = snap && typeof snap === 'object' ? (snap as { reason?: unknown }).reason : undefined;
          return { unavailable: true, reason: reason ?? 'no frame' };
        }
        return { bytes: dataUrl.length, dataUrl: `${dataUrl.slice(0, 64)}…` };
      },
    },
  ];
}

/** Product-shell registration point for host tools. Keeping this composition
 * named and testable prevents a new editor capability from being implemented
 * but accidentally omitted at `createForgeaxApp` boot. */
export function studioHostTools(adapter?: CarrierGameplayAdapter): HostToolSpec[] {
  return [...gameHostTools(), ...editorGatewayHostTools(), gameplayHostTool(adapter)];
}

export function gameplayHostTool(adapter?: CarrierGameplayAdapter): HostToolSpec {
  return {
    name: 'gameplay',
    description: 'Run a typed gameplay operation on the existing live carrier.',
    inputSchema: GAMEPLAY_INPUT_SCHEMA,
    run: async (args) => {
      let operation;
      try {
        operation = parseGameplayOperation(args);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'operation-unsupported',
            phase: 'dispatch',
            retryable: false,
            message: error instanceof Error ? error.message : 'Invalid gameplay operation payload.',
            hint: { action: 'status' },
          },
        };
      }
      return adapter
        ? adapter.execute(operation)
        : { ok: false, error: { code: 'dependency-gate-closed', phase: 'dependency', retryable: false, message: 'Gameplay adapter is not configured.', hint: { action: 'status' } } };
    },
  };
}
