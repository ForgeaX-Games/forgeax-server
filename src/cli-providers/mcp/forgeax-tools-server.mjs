#!/usr/bin/env node
/** forgeax host-tools MCP server (stdio) — the single way every external CLI
 *  provider (cursor-agent / claude-code / codex) reaches forgeax host tools.
 *  Plain JSON-RPC over stdio (no SDK), sibling of mcp/permission-server.mjs.
 *
 *  Two tool sources are merged (this is the CLI-side twin of the native
 *  `host_tool_bridge` kit, which surfaces the SAME tools to the in-process
 *  agent). BOTH dispatch through POST /api/tools/call (caller.kind='ai'):
 *    1. The generic Host ToolRegistry — every plugin-declared tool with
 *       `exposedToAI:true` + a handler, filtered to THIS agent's whitelist
 *       (GET /api/tools?agent=…). Makes ANY marketplace plugin's AI tools
 *       reachable from the CLI providers, not just a hardcoded set.
 *    2. wb-bgm (search/attach/list) ALWAYS-on for CLI agents. wb-bgm's logic
 *       lives in the marketplace plugin (registry tools), but game-building CLI
 *       agents have no `provides.agent.tools` whitelist, so Source 1 wouldn't
 *       surface it — we list it here from the shared spec (no logic, same
 *       /api/tools/call dispatch). Deduped by name so it shadows Source 1.
 *
 *  Logic stays single-sourced in the marketplace plugin; this shell only
 *  forwards over HTTP. Config: FORGEAX_SERVER_URL (default :18900). Fails soft
 *  — a registry-fetch error never drops the wb-bgm fallback. */

import { readFileSync } from 'node:fs';
import { BGM_TOOL_SPECS } from '../../lib/wb-bgm/tool-specs.ts';

const BASE = (process.env.FORGEAX_SERVER_URL || 'http://127.0.0.1:18900').replace(/\/$/, '');

async function httpJson(path, init) {
  const res = await fetch(BASE + path, init);
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.error) throw new Error(j?.message || j?.error || `HTTP ${res.status}`);
  return j;
}

/** Dispatch a registry tool via the host ToolRegistry endpoint (caller.kind=
 *  'ai'). The single forward used by BOTH tool sources; returns the unwrapped
 *  ToolResult.result. */
function callRegistryTool(toolId, args) {
  return httpJson('/api/tools/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolId, args, caller: { kind: 'ai' } }),
  }).then((r) => (r && typeof r === 'object' && 'result' in r ? r.result : r));
}

// ── Source 1: generic Host ToolRegistry (plugin-declared, exposedToAI) ──────

/** LLM/MCP tool names are constrained to ^[a-zA-Z0-9_-]{1,128}$; registry tool
 *  ids carry ':' / '.' (e.g. "narrative:start-pipeline"). Sanitize for the
 *  wire, keep a reverse map so tools/call can recover the real id. Mirrors the
 *  native host_tool_bridge.bridgeTool name mapping. */
function sanitizeName(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** ToolDescriptor.argsSchema is either an inline JSONSchema object or an
 *  absolute path string (the loader resolves the path but doesn't read it —
 *  see plugins/kinds/tool.ts:normalizeSchemaRef). Read+parse on demand, and
 *  degrade to an empty object schema so the LLM always gets a valid schema.
 *  Mirrors host_tool_bridge.toInputSchema. */
function toInputSchema(argsSchema) {
  let schema = argsSchema;
  if (typeof schema === 'string') {
    try { schema = JSON.parse(readFileSync(schema, 'utf-8')); } catch { schema = undefined; }
  }
  if (schema && typeof schema === 'object') {
    const s = schema;
    if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
      return {
        type: 'object',
        properties: s.properties,
        ...(Array.isArray(s.required) ? { required: s.required } : {}),
      };
    }
  }
  return { type: 'object', properties: {} };
}

/** Which agent this MCP instance serves. The provider that spawns us injects
 *  it (claude `--mcp-config` env / cursor `.cursor/mcp.json` env / codex `-c`
 *  env), mirroring how it tells the permission-server. Drives per-agent tool
 *  filtering so we DON'T dump the whole platform catalog at every CLI agent —
 *  parity with the native host_tool_bridge's opt-in/deny-all whitelist. */
const AGENT = (process.env.FORGEAX_AGENT || '').trim();

/** Fetch the registry catalog (filtered to THIS agent's `provides.agent.tools`
 *  whitelist by the server) and map exposedToAI+handler tools to MCP tools.
 *  Each tool's `run` dispatches via POST /api/tools/call with caller.kind='ai'
 *  so the host's exposedToAI gate + per-call env/cwd injection apply. When no
 *  agent is known we expose NO registry tools (only the wb-bgm fallback) rather
 *  than the full catalog. Fails soft: returns [] on any error. */
async function fetchRegistryTools() {
  if (!AGENT) return [];
  let catalog;
  try {
    catalog = await httpJson(`/api/tools?agent=${encodeURIComponent(AGENT)}`);
  } catch (e) {
    process.stderr.write(`[forgeax-tools] registry fetch failed: ${e?.message ?? e}\n`);
    return [];
  }
  const descriptors = Array.isArray(catalog?.tools) ? catalog.tools : [];
  const out = [];
  for (const d of descriptors) {
    if (!d?.id || !d.exposedToAI || !d.hasHandler) continue;
    const toolId = d.id;
    out.push({
      name: sanitizeName(toolId),
      description: d.description ?? toolId,
      inputSchema: toInputSchema(d.argsSchema),
      run: (args) => callRegistryTool(toolId, args),
    });
  }
  return out;
}

// ── wb-bgm audio library (always exposed to CLI agents) ─────────────────────
//
// wb-bgm's LOGIC now lives in the marketplace plugin (registry tools
// search-audio / attach-audio / list-audio). But game-building CLI agents are
// not whitelisted for those (they have no `provides.agent.tools`), so the
// per-agent registry enumeration (Source 1) wouldn't surface them. We keep wb-
// bgm ALWAYS-on for CLI by listing it here from the shared spec and dispatching
// each call through the SAME registry handler via /api/tools/call (no logic
// here — pure forward, reusing callRegistryTool). Deduped by name vs Source 1.

const BGM_TOOLS = BGM_TOOL_SPECS.map((s) => ({
  name: s.name,
  description: s.description,
  inputSchema: s.input_schema,
  run: (a) => callRegistryTool(s.name, a),
}));

// ── Merge + dispatch ────────────────────────────────────────────────────────

/** Resolve the live tool set: wb-bgm first (transitional, takes name
 *  precedence) ∪ registry tools whose sanitized name doesn't collide. Recomputed
 *  per tools/list so /api/plugins/reload-added tools surface without restart. */
async function resolveTools() {
  const byName = new Map(BGM_TOOLS.map((t) => [t.name, t]));
  for (const t of await fetchRegistryTools()) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  return byName;
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'forgeax-tools', version: '0.2.0' },
    } });
  } else if (method === 'notifications/initialized') {
    /* no response */
  } else if (method === 'tools/list') {
    const tools = await resolveTools();
    send({ jsonrpc: '2.0', id, result: {
      tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    } });
  } else if (method === 'tools/call') {
    const tools = await resolveTools();
    const tool = tools.get(params?.name);
    if (!tool) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${params?.name}` }], isError: true } }); return; }
    try {
      const r = await tool.run(params?.arguments ?? {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${params?.name} failed: ${e?.message ?? e}` }], isError: true } });
    }
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { let m; try { m = JSON.parse(line); } catch { continue; } handle(m); }
  }
});
