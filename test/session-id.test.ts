import { describe, expect, it } from 'bun:test';
import { sessionIdFromAgentDir } from '../src/fs/session-id';

describe('sessionIdFromAgentDir', () => {
  it('parses Unix-style agentDir', () => {
    expect(
      sessionIdFromAgentDir('/home/you/.forgeax/sessions/abc-123/agents/character-designer-2d'),
    ).toBe('abc-123');
  });

  it('parses Windows-style agentDir', () => {
    expect(
      sessionIdFromAgentDir(
        'C:\\Users\\AW4\\.forgeax\\sessions\\d443d1af-65a9-4e56-9571-b5a27ff07d07\\agents\\character-designer-2d',
      ),
    ).toBe('d443d1af-65a9-4e56-9571-b5a27ff07d07');
  });
});
