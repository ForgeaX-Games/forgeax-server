import { Hono } from 'hono';
import type { VideoAssetProvider, VideoAssetProviderControl } from './contracts';
import { parseVideoStorageConfig } from './config';
import type { ProjectRootResolver } from './game-path';
import { resolveVideoAssetsDir } from './game-path';
import { VideoAssetManifestRepository } from './manifest-repository';
import { VideoAssetProviderRegistry } from './provider-registry';
import { createCosVideoAssetProvider } from './providers/cos';
import { createLocalVideoAssetProvider } from './providers/local';
import { createS3VideoAssetProvider } from './providers/s3';
import { createVideoAssetRouter } from './router';
import { VideoAssetService, type UploadSessionRepository } from './service';
import {
  UploadSessionStore,
  type UploadSession,
  type ValidateUploadSessionInput,
} from './upload-sessions';

export class ProjectUploadSessionRepository implements UploadSessionRepository {
  readonly #getProjectRoot: ProjectRootResolver;
  readonly #stores = new Map<string, UploadSessionStore>();

  constructor(getProjectRoot: ProjectRootResolver) {
    this.#getProjectRoot = getProjectRoot;
  }

  #store(gameId: string): UploadSessionStore {
    const assetsDir = resolveVideoAssetsDir(gameId, this.#getProjectRoot);
    let store = this.#stores.get(assetsDir);
    if (!store) {
      store = new UploadSessionStore(assetsDir);
      this.#stores.set(assetsDir, store);
    }
    return store;
  }

  write(session: UploadSession): Promise<void> {
    return this.#store(session.gameId).write(session);
  }

  read(token: string, gameId: string): Promise<UploadSession | null> {
    return this.#store(gameId).read(token);
  }

  validate(session: UploadSession, input: ValidateUploadSessionInput, now?: number): void {
    this.#store(session.gameId).validate(session, input, now);
  }

  reserve(token: string, resourceId: string, gameId: string): Promise<UploadSession> {
    return this.#store(gameId).reserve(token, resourceId);
  }

  complete(token: string, resourceId: string, gameId: string): Promise<UploadSession> {
    return this.#store(gameId).complete(token, resourceId);
  }
}

export interface VideoAssetRuntime {
  router: Hono;
  service: VideoAssetService;
  providerControl: VideoAssetProviderControl;
}

export interface CreateVideoAssetRuntimeOptions {
  getProjectRoot: ProjectRootResolver;
  env?: NodeJS.ProcessEnv;
}

function createDefaultVideoAssetProvider(
  config: ReturnType<typeof parseVideoStorageConfig>,
  getProjectRoot: ProjectRootResolver,
): VideoAssetProvider {
  switch (config.kind) {
    case 'local':
      return createLocalVideoAssetProvider(getProjectRoot);
    case 's3':
      return createS3VideoAssetProvider(config);
    case 'cos':
      return createCosVideoAssetProvider(config);
  }
}

export function createVideoAssetRuntime(
  options: CreateVideoAssetRuntimeOptions,
): VideoAssetRuntime {
  const config = parseVideoStorageConfig(options.env);
  const manifest = new VideoAssetManifestRepository();
  const uploadSessions = new ProjectUploadSessionRepository(options.getProjectRoot);
  const defaultProvider = createDefaultVideoAssetProvider(config, options.getProjectRoot);
  const registry = new VideoAssetProviderRegistry(defaultProvider);
  const service = new VideoAssetService({
    getProjectRoot: options.getProjectRoot,
    providers: registry,
    manifest,
    uploadSessions,
  });

  return {
    router: createVideoAssetRouter(service),
    service,
    providerControl: registry.control,
  };
}

export { createVideoAssetRouter } from './router';
