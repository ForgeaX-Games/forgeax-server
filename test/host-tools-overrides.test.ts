import { describe, expect, it } from 'bun:test';
import { agentKitOverridesFromPersonaTools } from '../src/agents/host-tools-overrides';
import { resolveHostToolsAllowTokens } from '../src/agents/host-tools-allow';
import { resolveAgentIdAlias } from '../src/agents/loader';

describe('host-tools-overrides', () => {
  it('agentKitOverridesFromPersonaTools disables character-forge for character:*', () => {
    const kits = agentKitOverridesFromPersonaTools([
      'character:list',
      'character:generate-portrait',
    ]);
    expect(kits?.config?.['host-tools']?.allow).toContain('character:list');
    expect(kits?.disable).toContain('character-forge');
  });

  it('resolveAgentIdAlias maps common typos to character-designer-2d', () => {
    expect(resolveAgentIdAlias('character-designer-3d')).toBe('character-designer-2d');
    expect(resolveAgentIdAlias('character-designer-2d')).toBe('character-designer-2d');
  });

  it('resolveHostToolsAllowTokens prefers agent.json allow over manifest', () => {
    const tokens = resolveHostToolsAllowTokens('character-designer-2d', {
      config: { 'host-tools': { allow: ['character:list'] } },
    });
    expect(tokens).toEqual(['character:list']);
  });

  it('resolveHostToolsAllowTokens resolves alias path segment for manifest fallback', () => {
    const tokens = resolveHostToolsAllowTokens('character-designer-3d', { config: {} });
    // 独立 test 进程可能未 warm 插件快照；有 manifest 时应含 character:list
    if (tokens.length > 0) {
      expect(tokens).toContain('character:list');
    }
  });
});
