import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkbenchHost,
  scanExtensionSource,
} from '@forgeax/workbench-host/node';
import type {
  CurrentVersion,
  GameFileCapability,
  GameVersion,
  MediaAsset,
  MediaCapability,
  MediaWriteInput,
  ServiceBinding,
  VersionAdapter,
  WorkspaceAdapter,
} from '@forgeax/workbench-host/contracts';
import type { WorkbenchHost } from '@forgeax/workbench-host/node';
import {
  createForgeaxWorkbenchHostGetter,
  resolveInstalledWorkbenchPackage,
  type ForgeaxWorkbenchHostDependencies,
} from '../../src/workbench/runtime';
import { createRemoteKinoBinding } from '../../src/workbench/remote-kino-binding';
import { MockKinoServer } from './mock-kino-server';

const roots: string[] = [];
const GAME_ID = 'arrival-local-game-id';

class InMemoryMedia implements MediaCapability {
  readonly #assets = new Map<string, { asset: MediaAsset; body: { contentType: string; bytes: Uint8Array } }>();
  readonly #keys = new Map<string, string>();

  seed(id: string, contentType: string, bytes = new Uint8Array([1, 2, 3])): void {
    this.#assets.set(id, {
      asset: { id, type: contentType === 'video/mp4' ? 'video' : 'image', contentType, url: `https://media.mock.local/${id}` },
      body: { contentType, bytes },
    });
  }

  async list(gameId: string): Promise<MediaAsset[]> {
    void gameId;
    return [...this.#assets.values()].map(({ asset }) => structuredClone(asset));
  }

  async read(gameId: string, assetId: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
    void gameId;
    const value = this.#assets.get(assetId);
    return value ? { contentType: value.body.contentType, bytes: new Uint8Array(value.body.bytes) } : null;
  }

  async put(gameId: string, input: MediaWriteInput): Promise<MediaAsset> {
    void gameId;
    if (input.idempotencyKey) {
      const previous = this.#keys.get(input.idempotencyKey);
      if (previous) return structuredClone(this.#assets.get(previous)!.asset);
    }
    const id = `host-${createHash('sha256').update(input.idempotencyKey ?? input.filename).digest('hex').slice(0, 24)}`;
    const asset: MediaAsset = {
      id,
      type: input.contentType === 'video/mp4' ? 'video' : 'image',
      contentType: input.contentType,
      url: `https://media.mock.local/${id}`,
      sizeBytes: input.bytes.byteLength,
      metadata: input.metadata,
    };
    this.#assets.set(id, { asset, body: { contentType: input.contentType, bytes: new Uint8Array(input.bytes) } });
    if (input.idempotencyKey) this.#keys.set(input.idempotencyKey, id);
    return structuredClone(asset);
  }

  async delete(gameId: string, assetId: string): Promise<void> {
    void gameId;
    this.#assets.delete(assetId);
  }
}

class InMemoryWorkspace implements WorkspaceAdapter {
  readonly #root: string;
  readonly #games = new Map<string, Map<string, Uint8Array>>();
  #lock: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = root;
  }

  addGame(gameId: string): void {
    this.#games.set(gameId, new Map());
  }

  async resolveGameRoot(gameId: string): Promise<string> {
    if (!this.#games.has(gameId)) throw new Error(`workspace ${gameId} does not exist`);
    await mkdir(join(this.#root, gameId), { recursive: true });
    return join(this.#root, gameId);
  }

  writeJson(gameId: string, path: string, value: unknown): void {
    const files = this.#games.get(gameId);
    if (!files) throw new Error(`workspace ${gameId} does not exist`);
    files.set(path, new TextEncoder().encode(JSON.stringify(value)));
  }

  async withGameRoot<T>(
    gameId: string,
    options: { readonly create: boolean; readonly versioning: VersionAdapter },
    operation: (scope: {
      readonly gameRoot: string;
      readonly files: GameFileCapability;
      readonly versions: {
        ensureRepository(): Promise<void>;
        createVersion(message: string): Promise<GameVersion>;
        currentVersion(): Promise<CurrentVersion | null>;
        listVersions(): Promise<GameVersion[]>;
        readFileAtVersion(tag: string, relativePath: string): Promise<Uint8Array | null>;
      };
    }) => Promise<T>,
  ): Promise<T> {
    let files = this.#games.get(gameId);
    if (!files && options.create) {
      files = new Map();
      this.#games.set(gameId, files);
    }
    if (!files) throw new Error(`workspace ${gameId} does not exist`);

    const workspace = this;
    const fileCapability: GameFileCapability = {
      async list(directory) {
        const prefix = directory.endsWith('/') ? directory : `${directory}/`;
        return [...files!.keys()]
          .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map((path) => path.slice(prefix.length))
          .sort();
      },
      async read(path) {
        const bytes = files!.get(path);
        return bytes ? new Uint8Array(bytes) : null;
      },
      async write(path, contents) {
        files!.set(path, new Uint8Array(contents));
      },
      async delete(path) {
        files!.delete(path);
      },
      async withLocks(_keys, callback) {
        const previous = workspace.#lock;
        let release!: () => void;
        workspace.#lock = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    };

    const versions = {
      async ensureRepository(): Promise<void> {},
      async createVersion(message: string): Promise<GameVersion> {
        return { tag: `v-${message}`, commitHash: 'mock', message, createdAt: new Date().toISOString() };
      },
      async currentVersion(): Promise<CurrentVersion | null> { return null; },
      async listVersions(): Promise<GameVersion[]> { return []; },
      async readFileAtVersion(_tag: string, _path: string): Promise<Uint8Array | null> { return null; },
    };

    await mkdir(join(this.#root, gameId), { recursive: true });
    return operation({
      gameRoot: join(this.#root, gameId),
      files: fileCapability,
      versions,
    });
  }
}

const mockVersioning: VersionAdapter = {
  async ensureRepository() {},
  async createVersion(gameRoot, message) {
    return { tag: `v-${message}`, commitHash: 'mock', message, createdAt: new Date().toISOString() };
  },
  async currentVersion(_gameRoot): Promise<CurrentVersion | null> { return null; },
  async listVersions(_gameRoot): Promise<GameVersion[]> { return []; },
  async readFileAtVersion(_gameRoot, _tag, _path): Promise<Uint8Array | null> { return null; },
};

function toolResult<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
    throw new Error(`Workbench tool failed: ${JSON.stringify(value)}`);
  }
  return (value as { result: T }).result;
}

async function hostFor(
  projectRoot: string,
  media: InMemoryMedia,
  workspace: InMemoryWorkspace,
  binding: ServiceBinding,
): Promise<WorkbenchHost> {
  const dependencies: Partial<ForgeaxWorkbenchHostDependencies> = {
    packageExtension: resolveInstalledWorkbenchPackage,
    scanExtensionSource,
    async createAdapters(_options, _runtimeId) {
      return {
        workspace,
        versioning: mockVersioning,
        media,
        models: {} as never,
        serviceBindings: [binding],
        generation: { pollIntervalMs: 0, foregroundTimeoutMs: 1_000 },
      };
    },
    createWorkbenchHost,
  };
  return createForgeaxWorkbenchHostGetter(dependencies)({
    projectRoot,
    mediaService: {} as never,
    modelRouter: {} as never,
  });
}


describe('ForgeaX Kino workbench capability acceptance', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('catalogs both extensions, runs the Asset Canvas tool through Host, recovers receipts, and exposes the media asset to wb-game-video', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-kino-e2e-'));
    roots.push(root);
    const media = new InMemoryMedia();
    const workspace = new InMemoryWorkspace(root);
    workspace.addGame(GAME_ID);
    const kino = new MockKinoServer();
    const binding = await createRemoteKinoBinding({
      projectRoot: root,
      installationId: 'installation-a',
      env: {
        FORGEAX_KINO_BASE_URL: kino.origin,
        FORGEAX_KINO_GATEWAY_TOKEN: kino.gatewayToken,
        FORGEAX_KINO_NAMESPACE_SECRET: Buffer.alloc(32, 7).toString('base64url'),
        FORGEAX_KINO_OUTPUT_ORIGINS: kino.origin,
      },
      fetch: kino.fetch.bind(kino) as typeof fetch,
    });
    const host = await hostFor(root, media, workspace, binding);
    const catalog = await host.catalog(GAME_ID) as readonly { extensionId: string }[];
    expect(catalog.filter((entry) => entry.extensionId === '@forgeax/wb-game-video')).toHaveLength(1);
    expect(catalog.filter((entry) => entry.extensionId === '@forgeax-extension/wb-asset-canvas')).toHaveLength(1);

    const startedRaw = await host.callTool({
      caller: 'ai',
      toolId: 'asset-canvas:start-video-generation',
      gameId: GAME_ID,
      args: {
        prompt: 'A paper boat crossing a moonlit canal, no text',
        durationSeconds: 5,
        idempotencyKey: 'canvas-v1',
      },
    });
    const started = toolResult<{ job: { jobId: string; status: string } }>(startedRaw);
    expect(started.job.jobId).toMatch(/^gen_[a-f0-9]{64}$/u);
    expect(['created', 'submitting', 'polling', 'succeeded']).toContain(started.job.status);

    // Recreate the complete product Host while the first job is active. The
    // receipt is read from the same game workspace; no second POST occurs.
    const recreatedBinding = await createRemoteKinoBinding({
      projectRoot: root,
      installationId: 'installation-a',
      env: {
        FORGEAX_KINO_BASE_URL: kino.origin,
        FORGEAX_KINO_GATEWAY_TOKEN: kino.gatewayToken,
        FORGEAX_KINO_NAMESPACE_SECRET: Buffer.alloc(32, 7).toString('base64url'),
        FORGEAX_KINO_OUTPUT_ORIGINS: kino.origin,
      },
      fetch: kino.fetch.bind(kino) as typeof fetch,
    });
    const recreatedHost = await hostFor(root, media, workspace, recreatedBinding);
    let canvasJob: { jobId: string; status: string; assets?: readonly MediaAsset[] } = started.job;
    for (let attempt = 0; attempt < 50 && canvasJob.status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = toolResult<{ job: typeof canvasJob }>(await recreatedHost.callTool({
        caller: 'ui',
        toolId: 'asset-canvas:get-video-generation',
        gameId: GAME_ID,
        args: { jobId: started.job.jobId },
      }));
      canvasJob = result.job;
    }
    expect(canvasJob.status).toBe('succeeded');
    const canvasAsset = canvasJob.assets?.[0];
    expect(canvasAsset?.id).toMatch(/^host-[a-f0-9]{24}$/u);
    expect(canvasAsset?.type).toBe('video');
    expect(canvasAsset?.contentType).toBe('video/mp4');

    // Seed two Host media references in the wb-game-video registry. The second
    // extension receives them through its own tool contract, while the actual
    // video call still resolves to the same Host video-generation capability.
    media.seed('character-host', 'image/png');
    media.seed('scene-host', 'image/png');
    workspace.writeJson(GAME_ID, 'assets/manifest.json', {
      version: 2,
      assets: [
        {
          id: 'character-ref',
          kind: 'image',
          productionType: 'character_ref',
          status: 'ready',
          mime: 'image/png',
          provider: { kind: 'local', ref: 'character-host' },
          meta: {
            hostMedia: {
              provenance: 'workbench-media-capability',
              assetId: 'character-host',
              locator: 'https://media.mock.local/character-host',
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'scene-ref',
          kind: 'image',
          productionType: 'scene_ref',
          status: 'ready',
          mime: 'image/png',
          provider: { kind: 'local', ref: 'scene-host' },
          meta: {
            hostMedia: {
              provenance: 'workbench-media-capability',
              assetId: 'scene-host',
              locator: 'https://media.mock.local/scene-host',
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const generated = toolResult<{ asset: MediaAsset & { kind?: string; mime?: string; meta?: Record<string, unknown> } }>(await recreatedHost.callTool({
      caller: 'ai',
      toolId: 'wb-game-video:generate-video',
      gameId: GAME_ID,
      args: {
        sceneNodeId: 'node-1',
        nodeName: 'Moonlit Canal',
        seedancePrompt: 'A paper boat crosses the canal in one continuous shot, no text',
        durationSeconds: 5,
        characterRefIds: ['character-ref'],
        sceneRefIds: ['scene-ref'],
      },
    }));
    const gameVideoAsset = generated.asset;
    const gameVideoHostMedia = gameVideoAsset.meta?.hostMedia as { assetId?: unknown } | undefined;
    const gameVideoHostAssetId = String(gameVideoHostMedia?.assetId ?? '');
    expect(gameVideoAsset.id).toMatch(/^a-vid-[a-z0-9-]+$/u);
    expect(gameVideoHostAssetId).toMatch(/^host-[a-f0-9]{24}$/u);
    expect(gameVideoAsset.kind).toBe('video');
    expect(gameVideoAsset.mime).toBe('video/mp4');
    expect(gameVideoHostAssetId).not.toBe(canvasAsset!.id);

    // The generated host media is now visible through wb-game-video's own
    // shared registry, proving the extension-to-extension consumption path.
    const listed = toolResult<{ assets: readonly { id: string; kind: string }[] }>(await recreatedHost.callTool({
      caller: 'ai',
      toolId: 'wb-game-video:list-assets',
      gameId: GAME_ID,
      args: {},
    }));
    expect(listed.assets.some((asset) => asset.id === gameVideoAsset.id)).toBe(true);

    const generationRequests = kino.generationRequests;
    expect(generationRequests).toHaveLength(2);
    for (const request of generationRequests) {
      const payload = request.body as { game_id?: unknown };
      expect(payload.game_id).toMatch(/^fx_[a-f0-9]{64}$/u);
      expect(payload.game_id).not.toBe(GAME_ID);
      expect(request.headers.get('x-gateway-token')).toBe(kino.gatewayToken);
      expect(request.headers.get('authorization')).toBeNull();
    }
    expect(new Set(generationRequests.map((request) => (request.body as { game_id: string }).game_id)).size).toBe(1);

    kino.removeOutputUrls();
    const persistedCanvas = await media.read(GAME_ID, canvasAsset!.id);
    expect(persistedCanvas?.contentType).toBe('video/mp4');
    const persistedGameVideo = await media.read(GAME_ID, gameVideoHostAssetId);
    expect(persistedGameVideo?.contentType).toBe('video/mp4');
    expect(persistedCanvas?.bytes.byteLength).toBeGreaterThan(0);
    expect(persistedGameVideo?.bytes.byteLength).toBeGreaterThan(0);

    const otherBinding = await createRemoteKinoBinding({
      projectRoot: root,
      installationId: 'installation-b',
      env: {
        FORGEAX_KINO_BASE_URL: kino.origin,
        FORGEAX_KINO_GATEWAY_TOKEN: kino.gatewayToken,
        FORGEAX_KINO_NAMESPACE_SECRET: Buffer.alloc(32, 7).toString('base64url'),
        FORGEAX_KINO_OUTPUT_ORIGINS: kino.origin,
      },
      fetch: kino.fetch.bind(kino) as typeof fetch,
    });
    const otherHost = await hostFor(root, media, workspace, otherBinding);
    const otherStarted = toolResult<{ job: { jobId: string; status: string } }>(await otherHost.callTool({
      caller: 'ai',
      toolId: 'asset-canvas:start-video-generation',
      gameId: GAME_ID,
      args: {
        prompt: 'A second isolated paper boat crossing a moonlit canal, no text',
        durationSeconds: 5,
        idempotencyKey: 'other-installation-v1',
      },
    }));
    expect(otherStarted.job.jobId).toMatch(/^gen_[a-f0-9]{64}$/u);
    const scopes = kino.generationRequests.map((request) => (request.body as { game_id: string }).game_id);
    expect(new Set(scopes).size).toBe(2);
  });
});
