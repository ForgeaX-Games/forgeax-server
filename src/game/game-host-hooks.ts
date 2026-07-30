// game-host-hooks.ts — product-shell implementation of the game-host
// version-prepare hook (injected via ProductContext.gameHostBeforeVersion).
//
// Runs server-side right before `git add -A` when a game version is created.
// For wb-game-video games it copies the platform component set into the game
// dir so the components travel with that game's git version — no vite, no
// per-save client work; a plain Node fs copy.
//
// Layering: platform-io game-host stays generic (just invokes the hook); the
// knowledge of "which extension, which source path" lives here in the product
// shell (which already owns extension paths via `mp`).

import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { mp, assetRoot } from '@forgeax/platform-io';

/** User-uploaded fonts live directly in the game component package. */
const USER_COMPONENT_FONT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:woff2?|ttf|otf)$/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function filesEqual(a: string, b: string): Promise<boolean> {
  if (!(await exists(b))) return false;
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
}

/** Mirror generated component sources without touching identical files.
 * Vite watches every linked game directory; deleting and recopying the whole
 * tree on each blueprint save caused a full HMR/reload even when no component
 * changed, which remounted the editor and showed its initialization overlay. */
export async function syncComponentsExcludingTests(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const sourceEntries = (await readdir(src, { withFileTypes: true }))
    .filter((entry) => entry.name !== '__tests__');
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const destEntries = await readdir(dest, { withFileTypes: true });

  for (const destEntry of destEntries) {
    const sourceEntry = sourceEntries.find((entry) => entry.name === destEntry.name);
    if (USER_COMPONENT_FONT_RE.test(destEntry.name) && !sourceEntry) continue;
    const sameShape = sourceEntry
      && sourceEntry.isDirectory() === destEntry.isDirectory();
    if (sourceNames.has(destEntry.name) && sameShape) continue;
    await rm(join(dest, destEntry.name), { recursive: true, force: true });
  }

  await Promise.all(sourceEntries.map(async (entry) => {
    const sourcePath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await syncComponentsExcludingTests(sourcePath, destPath);
      return;
    }
    if (await filesEqual(sourcePath, destPath)) return;
    await copyFile(sourcePath, destPath);
  }));
}

/** wb-game-video component source (dev: extension `src`). */
function wbGameVideoComponentsSrc(): string {
  return mp('wb-game-video', 'src', 'runtime', 'component-host', 'components');
}

type Project = { platform?: unknown } | null | undefined;

/**
 * Version-prepare hook: for wb-game-video games, sync the platform component set
 * into `<gameDir>/components` before the version is committed. No-op for other
 * platforms, or when the source isn't present (packaged/prod dist-only builds —
 * the game version is already固化 there).
 */
export async function gameHostBeforeVersion(args: {
  slug: string;
  gameDir: string;
  project: unknown;
}): Promise<void> {
  const project = args.project as Project;
  if (project?.platform !== 'wb-game-video') return;
  const forgePath = resolve(args.gameDir, 'forge.json');
  if (await exists(forgePath)) {
    const forge = JSON.parse(await readFile(forgePath, 'utf-8')) as Record<string, unknown>;
    if (forge.projectType !== 'game-video') {
      await writeFile(
        forgePath,
        `${JSON.stringify({ ...forge, projectType: 'game-video' }, null, 2)}\n`,
        'utf-8',
      );
    }
  }
  const src = wbGameVideoComponentsSrc();
  if (!(await exists(src))) return; // prod/dist-only: components already固化
  const dest = resolve(args.gameDir, 'components');
  await syncComponentsExcludingTests(src, dest);
}

type CloneTemplateAssets = (input: {
  sourceGameDir: string;
  sourceGameId: string;
  targetGameDir: string;
  targetGameId: string;
}) => Promise<void>;

/** A new video game starts with one editable main blueprint and no gameplay data. */
function emptyVideoGameBlueprint(): Record<string, unknown> {
  const main = {
    id: 'bp-main',
    title: '主蓝图',
    entry: 'entry',
    graph: { nodes: [], edges: [] },
  };
  return {
    version: 'wb-game-video.graph.v1',
    entities: {},
    variables: {},
    graph: main.graph,
    manifest: {
      version: 'wb-game-video.blueprint-manifest.v1',
      mainPackId: main.id,
      packs: { [main.id]: main },
    },
  };
}

/** Clone bundled Nodia media into the target scope, but start from an empty blueprint. */
export async function gameHostSeedProvider(
  args: { slug: string; targetGameDir: string },
  cloneTemplateAssets: CloneTemplateAssets,
): Promise<{
  project: Record<string, unknown>;
  blueprint: unknown;
  assetsManifest: unknown;
}> {
  const root = resolve(assetRoot(), 'games', 'game-nodia-fighting');
  const manifestPath = resolve(root, 'assets', 'manifest.json');
  if (!(await exists(manifestPath))) {
    throw new Error('canonical game-nodia-fighting sample is missing');
  }
  await cloneTemplateAssets({
    sourceGameDir: root,
    sourceGameId: 'game-nodia-fighting',
    targetGameDir: args.targetGameDir,
    targetGameId: args.slug,
  });
  const assetsManifest = await readFile(
    resolve(args.targetGameDir, 'assets', 'manifest.json'),
    'utf-8',
  ).then(JSON.parse);
  return {
    project: {
      id: args.slug,
      title: args.slug,
      platform: 'wb-game-video',
      platformVersion: '1',
      entry: { blueprint: 'blueprint.json', components: 'dist/components' },
    },
    blueprint: emptyVideoGameBlueprint(),
    assetsManifest,
  };
}
