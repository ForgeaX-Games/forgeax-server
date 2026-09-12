import { afterEach, expect, test } from 'bun:test';
import {
  _resetActionCatalogValidationForTests,
  buildActionCatalog,
  catalogAll,
  catalogGet,
} from '@forgeax/orchestrator/kernel/action-catalog';
import { studioActionCatalog, studioHeadlessCompatibilityIds } from '../src/studio-action-catalog';

const handlers = ['role.create', 'role.list', 'session.create', 'session.close', 'sessions.list'];
afterEach(() => {
  _resetActionCatalogValidationForTests();
  buildActionCatalog();
});

test('the release Orchestrator compiles the complete Studio catalog without losing action facts', () => {
  buildActionCatalog(studioActionCatalog, {
    builtinHeadlessHandlerActionIds: handlers,
    headlessHandlerActionIds: [],
    grandfatheredHeadlessActionIds: studioHeadlessCompatibilityIds,
  });
  expect(catalogAll()).toHaveLength(22);
  for (const declaration of studioActionCatalog) {
    expect(catalogGet(declaration.id)).toEqual(declaration);
  }
  expect(catalogGet('game.switch')).toBeUndefined();
});

test('a subsequent generic host clears Studio actions and compatibility exceptions', () => {
  buildActionCatalog(studioActionCatalog, {
    builtinHeadlessHandlerActionIds: handlers,
    headlessHandlerActionIds: [],
    grandfatheredHeadlessActionIds: studioHeadlessCompatibilityIds,
  });
  buildActionCatalog(undefined, {
    builtinHeadlessHandlerActionIds: handlers,
    headlessHandlerActionIds: [],
    grandfatheredHeadlessActionIds: [],
  });
  expect(catalogAll().map(entry => entry.id).sort()).toEqual([...handlers].sort());
  expect(catalogGet('game.create')).toBeUndefined();
  expect(catalogGet('overlay.open')).toBeUndefined();
});
