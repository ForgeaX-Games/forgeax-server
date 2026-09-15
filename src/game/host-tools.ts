import { assetRecoveryHostTools, type AssetRecoveryHostDeps } from './asset-recovery-host-tools';
import { GameVerificationEvidence } from './game-verification-evidence';
import { GAME_VERIFICATION_INPUT_SCHEMA, StudioDeliveryClaimSchema, projectGameVerification } from './delivery-verification';
/** gameHostTools — the studio shell's game-domain host tools, injected into the
 *  orchestration layer via the `HostToolSpec` seam (Stage A §3 / P1-7).
 *  `list_games` and NPC authoring are declared here so the cli
 *  layer remains generic.
 *
 *  Execution uses two host-tool entry points (host-tool-bridge / `:sid/kernel-tool`)
 *  after the trust gate calls `run(args, ctx)`. Live editor observations use the typed editor_transport capability. The
 *  retired PlaySurface perception relay has no receiver in the current Editor
 *  and must not be advertised as an executable tool.
 *
 *  The leased-kernel path still has a local cli mirror; this seam covers the
 *  forgeax-core native path.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { HostToolSpec, HostToolRunCtx } from '@forgeax/orchestrator/seams';
import {
  type Affordance,
  type NpcDecisionDeadline,
} from '@forgeax/types/npc-protocol';
import { NPC_TOOL_CONTRACTS } from '@forgeax/types/npc-tools';
import { editorTransportHostTools, type EditorTransportHostToolsDeps } from './editor-transport-host-tools';
import { assetLibraryHostTools } from './asset-library-host-tools';
// 双轨期:上游已切换到 typed editor_transport(禁 JS relay);行走协议 editor_ui_browse
// 的编辑器腿仍走 relay-eval —— 本轮并存,迁移到 transport 记为显性债(见 docs/ai-native)。
import { editorGatewayHostTools } from './editor-gateway-host-tools';
import { editorUiBrowseHostTools } from './editor-ui-browse-host-tools';
import {
  DEFAULT_STUDIO_HOST_CAPABILITIES,
  type StudioHostCapabilities,
} from './studio-host-capabilities';
import {
  DeliverSummaryClaimSchema,
  DeliverSummarySchema,
} from '@forgeax/types/deliver-summary';
const GAME_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const NPC_BRAIN_FILE = 'src/npc-brain.ts';
const NPC_DIRECTORY = 'src/npcs';
const NPC_FILE = 'index.ts';
const PACKAGE_FILE = 'package.json';
const FORGE_FILE = 'forge.json';
const NPC_PATH_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const CONFIG_START = '// <forgeax:npc-brain-config>';
const CONFIG_END = '// </forgeax:npc-brain-config>';
const REGISTRY_START = '// <forgeax:npc-registry>';
const REGISTRY_END = '// </forgeax:npc-registry>';
/** JSON Schema sent to kernels. Runtime validation remains the zod contract
 * in @forgeax/types so wire metadata and execution cannot silently diverge. */
export const DELIVER_SUMMARY_INPUT_SCHEMA = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: { type: 'string', minLength: 1, maxLength: 500 },
    roundLabel: { type: 'string', maxLength: 24 },
    tests: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name', 'pass'],
        properties: {
          name: { type: 'string', minLength: 1 },
          pass: { type: 'boolean' },
          detail: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
    next: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', minLength: 1 },
    },
    build: { type: 'string', maxLength: 16 },
    verification: GAME_VERIFICATION_INPUT_SCHEMA,
  },
  additionalProperties: false,
} as const;

const DELIVER_SUMMARY_DESCRIPTION =
  'Optionally record semantic completion metadata for a meaningful task. Provide outcome as 1-5 concise, user-meaningful completion or confirmation points in the user\'s language (not a file-count statement). Include tests actually run with pass/fail and a short detail, and include up to 5 useful next recommendations or user decisions when applicable. Do not include changed files, line counts, duration, agents, cost, or artifact ids; the host derives file changes independently. For game work, report scoped verification with status passed, failed, or unverified and current evidence references. A passed gameplay report requires input followed by an observed state change and visual evidence. Reference exact verificationEvidence.id values from current editor_transport results. Edits, new Play attempts and gameplay failures invalidate prior evidence. Core-result and restart are request-specific observations, not mandatory game mechanics. Assess completeness against the user request; host receipts do not certify that assessment. Use changed-behavior for explicitly scoped partial validation. Missing verification is displayed as UNVERIFIED. These are agent-reported observations, not host-certified acceptance.';

function formatDeliverSummaryIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

async function runDeliverSummary(args: unknown, ctx: HostToolRunCtx, evidence: GameVerificationEvidence): Promise<unknown> {
  const parsed = StudioDeliveryClaimSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `deliver_summary arguments invalid: ${formatDeliverSummaryIssues(parsed.error)}`,
    };
  }
  if (!ctx.delivery) {
    return {
      ok: false,
      error: 'deliver_summary enrichment unavailable: orchestrator delivery seam is not configured',
    };
  }
  const evidenceError = ctx.game && ctx.game !== 'default' ? evidence.validate(parsed.data.verification, ctx) : undefined;
  if (evidenceError) return { ok: false, error: `Gameplay verification not accepted: ${evidenceError}` };
  const projected = DeliverSummaryClaimSchema.safeParse(projectGameVerification(parsed.data, ctx.game));
  if (!projected.success) return {
    ok: false,
    error: `deliver_summary projected claim invalid: ${formatDeliverSummaryIssues(projected.error)}`,
  };
  const summary = await ctx.delivery.enrich(projected.data);
  const checked = DeliverSummarySchema.safeParse(summary);
  if (!checked.success) {
    return {
      ok: false,
      error: `deliver_summary enrichment returned an invalid summary: ${formatDeliverSummaryIssues(checked.error)}`,
    };
  }
  return { ok: true, summary: checked.data };
}

/** List games from the current instance root and legacy root layout. */
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

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function resolveExistingGame(projectRoot: string, game: string): string | undefined {
  if (!GAME_ID.test(game)) return undefined;
  const canonicalRoot = resolve(projectRoot, '.forgeax', 'games');
  const legacyRoot = resolve(projectRoot, 'games');
  for (const root of [canonicalRoot, legacyRoot]) {
    const candidate = resolve(root, game);
    if (!pathInside(root, candidate) || !existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* inaccessible game directory */
    }
  }
  return undefined;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`npc_wire: invalid ${label}: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`npc_wire: ${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function updateJsonFile(
  path: string,
  label: string,
  mutate: (value: Record<string, unknown>) => void,
): boolean {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const value = readJsonObject(path, label);
  mutate(value);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (next === current) return false;
  writeFileSync(path, next);
  return true;
}

function ensureNpcPackageDependency(projectRoot: string, gameDir: string): boolean {
  const path = join(gameDir, PACKAGE_FILE);
  return updateJsonFile(path, PACKAGE_FILE, (pkg) => {
    const dependencies = pkg.dependencies;
    if (dependencies !== undefined && (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))) {
      throw new Error('npc_wire: package.json dependencies must be an object');
    }
    const npcClientDir = resolve(projectRoot, 'packages', 'npc-client');
    const dependency = pathInside(projectRoot, npcClientDir) && existsSync(join(npcClientDir, PACKAGE_FILE))
      ? `file:${relative(gameDir, npcClientDir).split('\\').join('/')}`
      : 'workspace:*';
    pkg.dependencies = {
      ...((dependencies as Record<string, unknown> | undefined) ?? {}),
      '@forgeax/npc-client': dependency,
    };
  });
}

function ensureNpcForgeConfig(gameDir: string, game: string): boolean {
  const path = join(gameDir, FORGE_FILE);
  return updateJsonFile(path, FORGE_FILE, (forge) => {
    const npc = forge.npc;
    if (npc !== undefined && (!npc || typeof npc !== 'object' || Array.isArray(npc))) {
      throw new Error('npc_wire: forge.json npc must be an object');
    }
    forge.id ??= game;
    forge.npc = {
      ...((npc as Record<string, unknown> | undefined) ?? {}),
      enabled: true,
      entry: NPC_BRAIN_FILE,
    };
  });
}

function managedBrainConfig(game: string): string {
  return `${CONFIG_START}\nexport const npcBrainConfig = {\n  game: ${serialize(game)},\n  npcs: npcDefinitions,\n} as const;\n${CONFIG_END}`;
}

function managedNpcDefinition(
  npcId: string,
  soulId: string,
  affordances: Affordance[],
  decisionDeadline?: NpcDecisionDeadline,
): string {
  const deadline = decisionDeadline
    ? `\n  decisionDeadline: ${serialize(decisionDeadline)},`
    : '';
  return `${CONFIG_START}\nexport const npcBrainWiring: Pick<NpcDefinition, 'npcId' | 'soulId' | 'decisionDeadline' | 'affordances'> = {\n  npcId: ${serialize(npcId)},\n  soulId: ${serialize(soulId)},${deadline}\n  affordances: ${serialize(affordances)},\n};\n${CONFIG_END}`;
}

function initialNpcDefinition(config: string): string {
  return `import type { NpcDefinition } from '..';\n\n${config}\n\n/** Game-owned Body binding and behavior hooks. npc_wire only updates npcBrainWiring. */\nexport const npcDefinition = {\n  ...npcBrainWiring,\n  displayName: npcBrainWiring.npcId,\n  body: { binding: npcBrainWiring.npcId },\n} satisfies NpcDefinition;\n`;
}

function managedNpcRegistry(npcIds: readonly string[]): string {
  const imports = npcIds
    .map((npcId, index) => `import { npcDefinition as npc${index} } from './${npcId}';`)
    .join('\n');
  const entries = npcIds.map((_npcId, index) => `  npc${index},`).join('\n');
  return `${REGISTRY_START}\n${imports}\n\nexport const npcDefinitions: readonly NpcDefinition[] = [\n${entries}\n];\n${REGISTRY_END}`;
}

function initialNpcRegistry(registry: string): string {
  return `import type { Affordance, NpcDecisionDeadline } from '@forgeax/npc-client';\n\nexport interface NpcDefinition {\n  readonly npcId: string;\n  readonly soulId: string;\n  readonly decisionDeadline?: NpcDecisionDeadline;\n  readonly displayName: string;\n  readonly body: Readonly<{ binding: string; [key: string]: unknown }>;\n  readonly affordances: readonly Affordance[];\n  readonly behavior?: Readonly<Record<string, unknown>>;\n}\n\n${registry}\n\nexport const npcDefinitionById: ReadonlyMap<string, NpcDefinition> = new Map(\n  npcDefinitions.map((definition) => [definition.npcId, definition]),\n);\n`;
}

function initialNpcBrainFile(config: string): string {
  return `import { NpcClient, NPC_PROTOCOL_VERSION, type NpcDecision, type PerceptionSnapshot } from '@forgeax/npc-client';\nimport { Time, Update, type World } from '@forgeax/engine-ecs';\nimport { npcDefinitions } from './npcs';\n\n${config}\n\nexport interface NpcBodyExecutor {\n  execute(npcId: string, action: string, params: Readonly<Record<string, string>>): boolean;\n  fallback(npcId: string, reason: string): void;\n}\n\nlet executor: NpcBodyExecutor | undefined;\n\nexport const callbacks = {\n  onUtterance(npcId: string, lines: readonly string[]) { void npcId; void lines; },\n  onEmotion(npcId: string, mood: string) { void npcId; void mood; },\n  onFallback(npcId: string, reason: string) { executor?.fallback(npcId, reason); },\n};\n\nconst brain = await NpcClient.connect({\n  game: npcBrainConfig.game,\n  npcIds: npcBrainConfig.npcs.map((npc) => npc.npcId),\n  npcs: npcBrainConfig.npcs.map((npc) => ({\n    npcId: npc.npcId,\n    soulId: npc.soulId,\n    ...(npc.decisionDeadline ? { decisionDeadline: npc.decisionDeadline } : {}),\n  })),\n  onIntentExpired: (npcId) => callbacks.onFallback(npcId, 'NPC intent expired'),\n});\nfor (const npc of npcBrainConfig.npcs) {\n  brain.declareAffordances(npc.npcId, [...npc.affordances]);\n  brain.onDecision(npc.npcId, applyNpcDecision);\n  brain.onFallback(npc.npcId, (error) => callbacks.onFallback(npc.npcId, error.message));\n}\n\nexport function attachNpcBody(body: NpcBodyExecutor): void {\n  executor = body;\n}\n\n/** Register the low-frequency Brain sampler in the game ECS update schedule. */\nexport function installNpcBrainSystem(\n  world: World,\n  sampleWorld: (npcId: string) => PerceptionSnapshot | undefined,\n): void {\n  world.addSystem(Update, {\n    name: 'forgeax-npc-brain',\n    queries: [],\n    resources: ['Time'],\n    fn: () => tickNpcBrain(world.getResource(Time).delta, sampleWorld),\n  });\n}\n\nexport function makeNpcSnapshot(\n  npcId: string,\n  input: Omit<PerceptionSnapshot, 'v' | 'game' | 'npcId' | 'affordances'>,\n): PerceptionSnapshot {\n  const npc = npcDefinitions.find((definition) => definition.npcId === npcId);\n  if (!npc) throw new Error(\`Unknown NPC: \${npcId}\`);\n  return {\n    ...input,\n    v: NPC_PROTOCOL_VERSION,\n    game: npcBrainConfig.game,\n    npcId,\n    affordances: [...npc.affordances],\n  };\n}\n\nexport function tickNpcBrain(\n  dt: number,\n  sampleWorld: (npcId: string) => PerceptionSnapshot | undefined,\n): void {\n  brain.tick(dt, sampleWorld);\n}\n\nexport async function requestNpcDecision(snapshot: PerceptionSnapshot): Promise<void> {\n  await brain.emit(snapshot);\n}\n\nfunction applyNpcDecision(decision: NpcDecision): void {\n  if (decision.utterance) callbacks.onUtterance(decision.npcId, decision.utterance.lines);\n  if (decision.emotion) callbacks.onEmotion(decision.npcId, decision.emotion.mood);\n  const intent = decision.intent;\n  if (!intent) return;\n  const npc = npcDefinitions.find((definition) => definition.npcId === decision.npcId);\n  const declared = npc?.affordances.some((item) => item.action === intent.action) ?? false;\n  if (!declared || !executor?.execute(decision.npcId, intent.action, intent.params ?? {})) {\n    callbacks.onFallback(decision.npcId, 'NPC Body rejected intent');\n  }\n}\n`;
}

function hasNpcClientImport(source: string): boolean {
  return /from\s+['"]@forgeax\/npc-client['"]/.test(source);
}

/** Insert managed config after the last top-level import; preserve Body / game code. */
function injectManagedConfig(current: string, config: string): string {
  const importFrom = /(?:^|\n)import[\s\S]*?from\s+['"][^'"]+['"]\s*;/g;
  let lastEnd = 0;
  for (const match of current.matchAll(importFrom)) {
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  if (lastEnd <= 0) return `${config}\n\n${current}`;
  const before = current.slice(0, lastEnd).replace(/\s*$/, '');
  const after = current.slice(lastEnd).replace(/^\s*/, '');
  return `${before}\n\n${config}\n\n${after}`;
}

function ensureNpcRegistryImport(current: string): string {
  if (/from\s+['"]\.\/npcs['"]/.test(current)) return current;
  return injectManagedConfig(current, "import { npcDefinitions } from './npcs';");
}

/** Upgrade the adapter emitted before per-NPC session bindings existed. */
function ensureNpcSessionBindings(current: string): string {
  if (/^\s*npcs:\s*npcBrainConfig\.npcs\.map\(/m.test(current)) return current;
  const legacyNpcIds = '  npcIds: npcBrainConfig.npcs.map((npc) => npc.npcId),';
  const offset = current.indexOf(legacyNpcIds);
  if (offset < 0) return current;
  const insertAt = offset + legacyNpcIds.length;
  const bindings = `
  npcs: npcBrainConfig.npcs.map((npc) => ({
    npcId: npc.npcId,
    soulId: npc.soulId,
    ...(npc.decisionDeadline ? { decisionDeadline: npc.decisionDeadline } : {}),
  })),`;
  return `${current.slice(0, insertAt)}${bindings}${current.slice(insertAt)}`;
}

function upsertManagedRegion(
  current: string,
  content: string,
  startMarker = CONFIG_START,
  endMarker = CONFIG_END,
): string | undefined {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start) throw new Error('npc_wire: malformed managed marker region');
  return `${current.slice(0, start)}${content}${current.slice(end + endMarker.length)}`;
}

function wireNpc(args: Record<string, unknown>, ctx: HostToolRunCtx): unknown {
  const parsed = NPC_TOOL_CONTRACTS.npc_wire.input.safeParse(args);
  if (!parsed.success) return { ok: false, error: `npc_wire: invalid input: ${parsed.error.message}` };
  const { game, npcId, soulId, affordances, decisionDeadline } = parsed.data;
  if (!NPC_PATH_ID.test(npcId) || npcId.includes('..')) {
    return { ok: false, error: 'npc_wire: npcId is not a safe directory name' };
  }

  const gameDir = resolveExistingGame(ctx.projectRoot, game);
  if (!gameDir) return { ok: false, error: `npc_wire: game ${JSON.stringify(game)} not found` };
  const brainFile = resolve(gameDir, NPC_BRAIN_FILE);
  const npcRoot = resolve(gameDir, NPC_DIRECTORY);
  const npcFile = resolve(npcRoot, npcId, NPC_FILE);
  const registryFile = resolve(npcRoot, NPC_FILE);
  const packageFile = resolve(gameDir, PACKAGE_FILE);
  const forgeFile = resolve(gameDir, FORGE_FILE);
  for (const file of [brainFile, npcFile, registryFile, packageFile, forgeFile]) {
    if (!pathInside(gameDir, file)) return { ok: false, error: 'npc_wire: target escapes game directory' };
  }

  const relativePath = (file: string): string => relative(ctx.projectRoot, file).split('\\').join('/');
  if (existsSync(npcFile)) {
    const current = readFileSync(npcFile, 'utf8');
    if (upsertManagedRegion(current, current) === undefined) {
      return {
        ok: false,
        error: `npc_wire: ${relativePath(npcFile)} exists without ForgeaX markers; refusing to overwrite user code`,
        changedPaths: [],
      };
    }
  }
  if (existsSync(registryFile)) {
    const current = readFileSync(registryFile, 'utf8');
    if (upsertManagedRegion(current, current, REGISTRY_START, REGISTRY_END) === undefined) {
      return {
        ok: false,
        error: `npc_wire: ${relativePath(registryFile)} exists without ForgeaX markers; refusing to overwrite user code`,
        changedPaths: [],
      };
    }
  }
  if (existsSync(brainFile)) {
    const current = readFileSync(brainFile, 'utf8');
    if (upsertManagedRegion(current, current) === undefined && !hasNpcClientImport(current)) {
      return {
        ok: false,
        error: `npc_wire: ${relativePath(brainFile)} exists without ForgeaX markers; refusing to overwrite user code`,
        changedPaths: [],
      };
    }
  }

  try {
    const pkg = readJsonObject(packageFile, PACKAGE_FILE);
    if (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) {
      throw new Error('npc_wire: package.json dependencies must be an object');
    }
    const forge = readJsonObject(forgeFile, FORGE_FILE);
    if (forge.npc !== undefined && (!forge.npc || typeof forge.npc !== 'object' || Array.isArray(forge.npc))) {
      throw new Error('npc_wire: forge.json npc must be an object');
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message, changedPaths: [] };
  }

  const changedPaths: string[] = [];
  try {
    if (ensureNpcPackageDependency(ctx.projectRoot, gameDir)) changedPaths.push(relativePath(packageFile));
    if (ensureNpcForgeConfig(gameDir, game)) changedPaths.push(relativePath(forgeFile));
  } catch (error) {
    return { ok: false, error: (error as Error).message, changedPaths: [] };
  }
  const npcConfig = managedNpcDefinition(npcId, soulId, affordances, decisionDeadline);
  let npcCreated = false;

  if (!existsSync(npcFile)) {
    mkdirSync(dirname(npcFile), { recursive: true });
    writeFileSync(npcFile, initialNpcDefinition(npcConfig));
    changedPaths.push(relativePath(npcFile));
    npcCreated = true;
  } else {
    const current = readFileSync(npcFile, 'utf8');
    const next = upsertManagedRegion(current, npcConfig);
    if (next === undefined) {
      return {
        ok: false,
        error: `npc_wire: ${relativePath(npcFile)} exists without ForgeaX markers; refusing to overwrite user code`,
        changedPaths: [],
      };
    }
    if (next !== current) {
      writeFileSync(npcFile, next);
      changedPaths.push(relativePath(npcFile));
    }
  }

  const npcIds = readdirSync(npcRoot, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || !NPC_PATH_ID.test(entry.name)) return false;
      const file = join(npcRoot, entry.name, NPC_FILE);
      return existsSync(file) && readFileSync(file, 'utf8').includes(CONFIG_START);
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const registry = managedNpcRegistry(npcIds);
  if (!existsSync(registryFile)) {
    writeFileSync(registryFile, initialNpcRegistry(registry));
    changedPaths.push(relativePath(registryFile));
  } else {
    const current = readFileSync(registryFile, 'utf8');
    const next = upsertManagedRegion(current, registry, REGISTRY_START, REGISTRY_END);
    if (next === undefined) {
      return {
        ok: false,
        error: `npc_wire: ${relativePath(registryFile)} exists without ForgeaX markers; refusing to overwrite user code`,
        changedPaths: [],
      };
    }
    if (next !== current) {
      writeFileSync(registryFile, next);
      changedPaths.push(relativePath(registryFile));
    }
  }

  const brainConfig = managedBrainConfig(game);
  if (!existsSync(brainFile)) {
    mkdirSync(dirname(brainFile), { recursive: true });
    writeFileSync(brainFile, initialNpcBrainFile(brainConfig));
    changedPaths.push(relativePath(brainFile));
  } else {
    const current = readFileSync(brainFile, 'utf8');
    const updated = upsertManagedRegion(current, brainConfig);
    let next: string;
    if (updated === undefined) {
      // Migration / hand-written adapters already on @forgeax/npc-client: inject
      // markers instead of refusing (Forge must not mv+wipe Body wiring).
      if (!hasNpcClientImport(current)) {
        return {
          ok: false,
          error: `npc_wire: ${relativePath(brainFile)} exists without ForgeaX markers; refusing to overwrite user code`,
          changedPaths: [],
        };
      }
      next = injectManagedConfig(current, brainConfig);
    } else {
      next = updated;
    }
    next = ensureNpcRegistryImport(next);
    next = ensureNpcSessionBindings(next);
    if (next !== current) {
      writeFileSync(brainFile, next);
      changedPaths.push(relativePath(brainFile));
    }
  }

  return {
    ok: true,
    created: npcCreated,
    changedPaths,
    path: relativePath(npcFile),
    registryPath: relativePath(registryFile),
    adapterPath: relativePath(brainFile),
  };
}

export function gameHostTools(
  capabilities: StudioHostCapabilities = DEFAULT_STUDIO_HOST_CAPABILITIES,
  evidence = new GameVerificationEvidence(),
): HostToolSpec[] {
  return [
    {
      name: 'deliver_summary',
      description: DELIVER_SUMMARY_DESCRIPTION,
      inputSchema: DELIVER_SUMMARY_INPUT_SCHEMA,
      run: (args, ctx) => runDeliverSummary(args, ctx, evidence),
    },
    {
      name: 'list_games',
      description: capabilities.editorRelay.available
        ? 'List the game projects in this ForgeaX instance. Returns { count, games }. READ-ONLY: to OPEN/SWITCH to a game the way a human does, do NOT hunt for slugs or read files — call editor_ui_browse open(\'menu:file/打开最近\') to reveal the recent list visually, then append the game\'s display name to the chain and call open again.'
        : 'List the game projects in this ForgeaX instance. Returns { count, games }. READ-ONLY: use editor_transport discover and typed game.select operations to inspect or switch the active game without a DEV relay.',
      inputSchema: { type: 'object', properties: {} },
      run: (_args, ctx: HostToolRunCtx) => listGames(ctx.projectRoot),
    },
    {
      name: 'npc_wire',
      description: NPC_TOOL_CONTRACTS.npc_wire.description,
      inputSchema: NPC_TOOL_CONTRACTS.npc_wire.inputSchema,
      run: (args, ctx: HostToolRunCtx) => wireNpc(args, ctx),
    },

  ];
}

/** Product-shell registration point for host tools. Keeping this composition
 * named and testable prevents a new editor capability from being implemented
 * but accidentally omitted at `createForgeaxApp` boot. */
export function studioHostTools(
  editorTransport?: EditorTransportHostToolsDeps,
  capabilities: StudioHostCapabilities = DEFAULT_STUDIO_HOST_CAPABILITIES,
  suppliedEvidence = new GameVerificationEvidence(),
  assetRecovery?: AssetRecoveryHostDeps,
): HostToolSpec[] {
  const evidence = suppliedEvidence;
  const relay = capabilities.editorRelay.available && capabilities.editorRelay.baseUrl
    ? { bridgeUrl: capabilities.editorRelay.baseUrl }
    : undefined;
  return [
    ...gameHostTools(capabilities, evidence),
    ...assetLibraryHostTools(editorTransport),
    ...assetRecoveryHostTools(assetRecovery),
    ...editorTransportHostTools(editorTransport).map(tool => evidence.wrap(tool)),
    ...(relay ? editorGatewayHostTools(relay) : []),
    ...(relay ? editorUiBrowseHostTools(relay) : []),
  ];
}
