/**
 * Character-forge backend SSOT.
 *
 * Two parallel consumers share this module:
 *   1. packages/server/src/api/wb-character.ts — Hono router
 *   2. packages/server/builtin/{commands,kits}/character-forge/* — agent / CLI / cron
 *      直接调 handler 拿 JSON,不走 HTTP
 *
 * Imported via the `@server-lib/character-forge` tsconfig path alias.
 * Previously this lived at `packages/marketplace/plugins/wb-character-forge/src/`
 * and was imported as `@forgeax-plugin/wb-character-forge` — the plugin shell was
 * removed in 2026-05-21 Phase 6 (see docs/v2-vision/modules/16-three-pane-embedding.md).
 */

export * from './handlers';
export type * from './types';
