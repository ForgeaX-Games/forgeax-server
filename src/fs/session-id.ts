/** 从 agent 家目录路径解析 session id（跨平台）。
 *  Windows: `C:\Users\...\sessions\<sid>\agents\foo`
 *  Unix:    `/home/you/sessions/<sid>/agents/foo`
 */
export function sessionIdFromAgentDir(agentDir: string): string | undefined {
  const parts = agentDir.split(/[/\\]+/).filter(Boolean);
  const idx = parts.lastIndexOf("sessions");
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  const sid = parts[idx + 1];
  return sid?.length ? sid : undefined;
}
