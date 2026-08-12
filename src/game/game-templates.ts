import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { assetRoot } from '@forgeax/platform-io';

export interface GameTemplate {
  slug: string;
  name: string;
}

interface EditorTemplateCatalog {
  listGameTemplates: (engineTemplatesRoot: string) => Promise<GameTemplate[]>;
}

/** Resolve the editor-owned template catalog in source and packaged runs. */
export function resolveEngineTemplatesRoot(): string {
  const candidates = [
    // Packaged resources mirror the repository's packages/ layout.
    resolve(assetRoot(), 'editor', 'packages', 'engine', 'templates'),
    // Source checkout: assetRoot() is already the repository packages/ root.
    resolve(assetRoot(), '..', 'packages', 'editor', 'packages', 'engine', 'templates'),
    // Keep compatibility with payloads that place the catalog beside the
    // packaged engine runtime rather than mirroring the editor tree.
    resolve(assetRoot(), 'engine', 'templates'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function resolveEditorTemplateCatalogModule(): string {
  const candidates = [
    // Current editor source layout.
    resolve(assetRoot(), 'editor', 'apps', 'standalone', 'template-catalog.ts'),
    resolve(assetRoot(), '..', 'packages', 'editor', 'apps', 'standalone', 'template-catalog.ts'),
    // Compatibility with editor revisions before the standalone app moved
    // under apps/.
    resolve(assetRoot(), 'editor', 'standalone', 'template-catalog.ts'),
    resolve(assetRoot(), '..', 'packages', 'editor', 'standalone', 'template-catalog.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Delegate catalog semantics to the editor SSOT; this is only a host adapter. */
export async function listGameTemplates(): Promise<GameTemplate[]> {
  const modulePath = resolveEditorTemplateCatalogModule();
  const catalog = await import(pathToFileURL(modulePath).href) as EditorTemplateCatalog;
  return catalog.listGameTemplates(resolveEngineTemplatesRoot());
}

export function createGameTemplatesRouter(): Hono {
  const router = new Hono();

  router.get('/game-templates', async (c) => {
    try {
      return c.json({ templates: await listGameTemplates() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  return router;
}
