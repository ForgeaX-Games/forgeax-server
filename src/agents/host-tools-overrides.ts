import type { AgentJson } from '../core/types';
import type { KitsConfig } from '../kits/types';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deepMerge } from '../utils/deep-merge';
import { getPathManager } from '../fs/path-manager';
import { resolvePersonaForAgent } from './loader';

/** 把 manifest `provides.agent.tools` 转成 agent.json kits 覆盖项。
 *  声明了 `character:*` 时禁用 legacy character-forge kit，避免与 host 桥
 *  接的 `character:generate-portrait` 等同名能力双份出现在 LLM 工具表。 */
export function agentKitOverridesFromPersonaTools(
  tools?: string[],
): AgentJson['kits'] | undefined {
  if (!tools?.length) return undefined;
  const kits: KitsConfig = {
    config: { 'host-tools': { allow: tools } },
  };
  if (tools.some((token) => token.startsWith('character:'))) {
    kits.disable = ['character-forge'];
  }
  return kits;
}

function hostToolsAllowList(kits?: KitsConfig): string[] {
  const allow = kits?.config?.['host-tools']?.allow;
  return Array.isArray(allow) ? allow.filter((v): v is string => typeof v === 'string') : [];
}

function kitsNeedPersonaTools(current: KitsConfig | undefined, desired: KitsConfig): boolean {
  const wantAllow = hostToolsAllowList(desired);
  if (wantAllow.length === 0) return false;
  const haveAllow = hostToolsAllowList(current);
  if (!wantAllow.every((token) => haveAllow.includes(token))) return true;
  const wantDisable = desired.disable ?? [];
  if (wantDisable.length === 0) return false;
  const haveDisable = current?.disable ?? [];
  return !wantDisable.every((token) => haveDisable.includes(token));
}

/** 已 scaffold 的 agent 补上 manifest 声明的 persona / host-tools（幂等）。 */
export async function ensureAgentPersonaKitOverrides(
  sid: string,
  agentPath: string,
): Promise<boolean> {
  const persona = await resolvePersonaForAgent(agentPath);
  if (!persona) return false;

  const layer = getPathManager().session(sid).agent(agentPath);
  const agentJsonPath = layer.agentJson();
  if (!existsSync(agentJsonPath)) return false;

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(agentJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return false;
  }

  const overrides: Partial<AgentJson> = {};
  if (persona.personaPath && current.personaFile !== persona.personaPath) {
    overrides.personaFile = persona.personaPath;
  }
  if (persona.memoryDir && current.memoryDir !== persona.memoryDir) {
    overrides.memoryDir = persona.memoryDir;
  }

  const desiredKits = persona.tools?.length
    ? agentKitOverridesFromPersonaTools(persona.tools)
    : undefined;
  const currentKits = current.kits as KitsConfig | undefined;
  if (desiredKits && kitsNeedPersonaTools(currentKits, desiredKits)) {
    overrides.kits = deepMerge(
      (currentKits ?? {}) as Record<string, unknown>,
      desiredKits as unknown as Record<string, unknown>,
    ) as KitsConfig;
  }

  if (Object.keys(overrides).length === 0) return false;

  const merged = deepMerge(
    current,
    overrides as unknown as Record<string, unknown>,
  );
  await writeFile(agentJsonPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  return true;
}
