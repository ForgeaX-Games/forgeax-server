/**
 * Regression — POST /api/workbench/games must keep forge.json.defaultScene
 * pointing at the scene asset after GUID regeneration.
 *
 * Root cause (2026-06-30): regeneratePackGuids re-issues every asset GUID in
 * the scaffold's *.pack.json files (so each game owns unique identities), but
 * forge.json.defaultScene is a REFERENCE to the scene asset's GUID and lived
 * outside the pack files. It was never remapped, so a freshly created game's
 * defaultScene dangled at the template's original GUID while the scene asset
 * had a brand-new one. At runtime this surfaced as forge-scene-unresolved and
 * asset-not-imported (POST /__import/<old-guid> 404).
 *
 * The fix threads regeneratePackGuids' old→new map back to the create handler,
 * which remaps defaultScene through it. This test locks that the scaffolded
 * defaultScene resolves to a real kind=scene asset and is no longer the
 * template's shared GUID.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { initPathManager, resetPathManager } from "@forgeax/orchestrator/fs/path-manager";
import { createWorkbenchRouter } from "../src/game/workbench";
import { getActiveGame, setActiveGame } from "../src/game/active-game";

let projectRoot: string;
let prevProjectRoot: string | undefined;
let app: Hono;
let ensured: string[];

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "forgeax-create-scene-"));
  const templateDir = resolve(projectRoot, ".forgeax/games/_template");
  mkdirSync(resolve(templateDir, "assets"), { recursive: true });
  writeFileSync(resolve(templateDir, "forge.json"), JSON.stringify({
    id: "scene-template", name: "Scene Template", schemaVersion: "1.0.0",
    entry: "main.ts", defaultScene: "1036f6f0-d3c2-5f31-9593-3432942d4c93",
  }));
  writeFileSync(resolve(templateDir, "main.ts"), "export const sceneGuid = '1036f6f0-d3c2-5f31-9593-3432942d4c93';\n");
  writeFileSync(resolve(templateDir, "assets/scene.pack.json"), JSON.stringify({
    version: 2,
    assets: [{
      guid: "1036f6f0-d3c2-5f31-9593-3432942d4c93",
      kind: "scene",
      name: "Scene",
      payload: { entities: [] },
      refs: [
        "cbe42beb-8975-5096-b3a1-3dda4cb4c077",
        "95730fd2-9846-5f84-8658-0b3c971eb263",
      ],
    }],
  }));
  prevProjectRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = projectRoot;
  resetPathManager();
  initPathManager({ projectRoot });
  ensured = [];
  app = new Hono();
  app.route("/api/workbench", createWorkbenchRouter({
    ensureSessionForGame: async (slug) => {
      ensured.push(slug);
      return { sid: `session-${slug}`, created: true };
    },
  }));
});

afterEach(() => {
  resetPathManager();
  if (prevProjectRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = prevProjectRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

interface PackJson {
  assets: Array<{ guid: string; kind?: string }>;
}

describe("POST /api/workbench/games remaps forge.json.defaultScene", () => {
  test("defaultScene resolves to the regenerated scene asset, not the template GUID", async () => {
    const slug = "scene-remap-game";
    const res = await app.request("/api/workbench/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    expect(res.status).toBe(200);
    expect(ensured).toEqual([slug]);

    const gameDir = resolve(projectRoot, ".forgeax/games", slug);
    const forge = JSON.parse(
      readFileSync(resolve(gameDir, "forge.json"), "utf-8"),
    ) as { defaultScene?: string };
    const scenePack = JSON.parse(
      readFileSync(resolve(gameDir, "assets/scene.pack.json"), "utf-8"),
    ) as PackJson;

    const sceneAsset = scenePack.assets.find((a) => a.kind === "scene");
    expect(sceneAsset).toBeDefined();
    // The reference must point at the freshly-issued scene GUID...
    expect(forge.defaultScene).toBe(sceneAsset!.guid);
    // ...and must NOT still be the template's shared GUID.
    expect(forge.defaultScene).not.toBe("1036f6f0-d3c2-5f31-9593-3432942d4c93");

    // A template may hardcode the scene GUID, or may consume ctx.defaultScene.
    // In either shape the old shared identity must not survive in source.
    const mainTs = readFileSync(resolve(gameDir, "main.ts"), "utf-8");
    expect(mainTs).not.toContain("1036f6f0-d3c2-5f31-9593-3432942d4c93");

    // References to SHARED/builtin assets (GUIDs the game does not define) must
    // be PRESERVED, not regenerated — regenerating them points at phantom GUIDs
    // (asset-not-found / /__import 404 → blank scene). The current template
    // references the engine's builtin cube and sphere from the scene pack.
    const BUILTIN_MESHES = [
      "cbe42beb-8975-5096-b3a1-3dda4cb4c077",
      "95730fd2-9846-5f84-8658-0b3c971eb263",
    ];
    const definedGuids = new Set(scenePack.assets.map((a) => a.guid));
    const sceneRaw = readFileSync(resolve(gameDir, "assets/scene.pack.json"), "utf-8");
    for (const guid of BUILTIN_MESHES) {
      expect(definedGuids.has(guid)).toBe(false);
      expect(sceneRaw).toContain(guid);
    }

    // Creating another game materializes it only; active-game selection is a
    // separate explicit transition and must remain on the first game.
    setActiveGame(projectRoot, slug);
    const second = await app.request("/api/workbench/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "second-game" }),
    });
    expect(second.status).toBe(200);
    expect(getActiveGame(projectRoot)).toBe(slug);
    expect(ensured).toEqual([slug, "second-game"]);
  });
});
