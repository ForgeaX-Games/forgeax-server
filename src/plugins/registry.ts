/**
 * Phase B3 — PluginRegistry: the in-process snapshot of every loaded plugin.
 *
 * Composes scanner → merger → kind dispatcher into a single observable
 * snapshot that the HTTP API and (Phase B4) the UI consume. Reloading is
 * idempotent: callers POST /api/plugins/reload and get a fresh snapshot
 * without restarting the server.
 *
 * This sits *next to* (not on top of) `kits/plugin-registry.ts`, which is
 * the older slot/tool registry from the bus runtime. They will merge in
 * a later Phase C/D PR — see 13-MIGRATION-ROADMAP.
 */
import { scanAllLayers, type ScanError } from './scanner';
import { mergeManifests, type MergedManifest, type MergeIssue } from './merger';
import { buildKindRegistry, type KindRegistry } from './kinds';
import type { PluginLayer } from './scanner';
import { getEventBus } from '../events/bus';
import { syncEventTriggerBindings } from '../skills/event-bridge';

export interface PluginSnapshot {
  /** Surrogate timestamp; bumps on every successful replaceFromManifests. */
  generation: number;
  loadedAt: number;
  manifests: MergedManifest[];
  kinds: KindRegistry;
  scanErrors: ScanError[];
  mergeIssues: MergeIssue[];
}

export interface PluginRegistryOpts {
  roots?: Partial<Record<PluginLayer, string | null>>;
}

const EMPTY: PluginSnapshot = {
  generation: 0,
  loadedAt: 0,
  manifests: [],
  kinds: {
    workbench: [],
    agents: [],
    skills: [],
    cliProviders: [],
    modelBindings: [],
    tools: [],
    issues: [],
  },
  scanErrors: [],
  mergeIssues: [],
};

let _current: PluginSnapshot = EMPTY;

export function getPluginSnapshot(): PluginSnapshot {
  return _current;
}

/** Reload from disk. Returns the new snapshot. Failures during scan are
 *  not fatal — they're surfaced in `scanErrors` so the UI/CI can flag
 *  them while the rest of the snapshot still works. */
export async function reloadPlugins(opts: PluginRegistryOpts = {}): Promise<PluginSnapshot> {
  const scan = await scanAllLayers(opts.roots);
  const merge = mergeManifests(scan.found);
  const kinds = buildKindRegistry(merge.manifests);
  const next: PluginSnapshot = {
    generation: _current.generation + 1,
    loadedAt: Date.now(),
    manifests: merge.manifests,
    kinds,
    scanErrors: scan.errors,
    mergeIssues: merge.issues,
  };
  _current = next;
  // Doc 04 §triggers — rewire `{kind:'event'}` skill triggers against the
  // fresh snapshot. Idempotent; the bridge tears down the previous bindings
  // before adding new ones.
  syncEventTriggerBindings(next, getEventBus());
  return next;
}

/** Test helper — install a hand-built snapshot without reading disk. */
export function _setSnapshotForTests(snap: PluginSnapshot): void {
  _current = snap;
}

export function _resetSnapshotForTests(): void {
  _current = EMPTY;
}
