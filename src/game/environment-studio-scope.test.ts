import { expect, mock, test } from 'bun:test';
mock.module('@forgeax/platform-io', () => ({ defaultProjectRoot: () => '/instance', assetRoot: () => '/resources' }));
mock.module('@forgeax/orchestrator/extensions', () => ({ getExtensionSnapshot: () => ({ manifests: [], kinds: { skills: [] } }) }));
mock.module('@forgeax/types', () => ({ pickI18n: () => '' }));
mock.module('./game-templates', () => ({ resolveEngineTemplatesRoot: () => '/resources/editor/packages/engine/templates' }));
const { renderEnvironmentText } = await import('./environment');
test('embedded game guidance names supplied paths and prevents standalone SDK detours', () => {
  const text = renderEnvironmentText({ cwd: '/instance', projectRoot: '/instance', slug: 'small-game' });
  expect(text).toContain('/instance/.forgeax/games/small-game/skills');
  expect(text).toContain('already been created by Studio');
  expect(text).toContain('SDK init/new and SDK ZIP production are not part of this workflow');
  expect(text).toContain('Do not use a global forgeax executable');
  expect(text).toContain('/instance/.forgeax/games/small-game/skills/<skill-id>/SKILL.md');
  expect(text).toContain('forgeax-engine-ecs');
  expect(text).toContain('extend the provided bootstrap/world');
  expect(text).toContain('tools actually exposed in this session');
  expect(renderEnvironmentText({ cwd: '/instance', projectRoot: '/instance' })).not.toContain('## Studio embedded project authoring');
});
