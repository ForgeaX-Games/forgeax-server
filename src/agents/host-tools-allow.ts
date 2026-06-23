import type { KitsConfig } from '../kits/types';
import { lookupAgent, resolveAgentIdAlias } from './loader';

/** agent tree path 最后一段（`character-designer-2d`）。 */
export function agentPathBasename(agentPath: string): string {
  const segs = agentPath.split('/');
  return segs[segs.length - 1] ?? agentPath;
}

/** host_tool_bridge 的 allow 列表：agent.json 优先，缺省回退 manifest `tools[]`。 */
export function resolveHostToolsAllowTokens(
  agentPath: string,
  kits?: KitsConfig,
): string[] {
  const fromJson = kits?.config?.['host-tools']?.allow;
  if (Array.isArray(fromJson) && fromJson.length > 0) {
    return fromJson.filter((v): v is string => typeof v === 'string');
  }
  const agentId = resolveAgentIdAlias(agentPathBasename(agentPath));
  return lookupAgent(agentId)?.definition.tools ?? [];
}
