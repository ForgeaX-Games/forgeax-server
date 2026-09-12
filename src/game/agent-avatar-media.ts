import { Hono } from 'hono';
import { resolve } from 'node:path';
import type { AgentAvatarRules } from '@forgeax/types';

type AvatarAgent = { definition: { id: string; avatarRules?: AgentAvatarRules } };

// Only URLs produced by the registered avatar loader can become local media.
// The request selects an agent/state, never a caller-supplied filesystem path.
function registeredMediaPath(url: string, assets: string): string | null {
  try {
    const parsed = new URL(url, 'http://studio.invalid');
    const path = parsed.searchParams.get('path');
    if (parsed.origin !== 'http://studio.invalid' || parsed.pathname !== '/api/files/raw'
      || !path?.startsWith('packages/') || path.includes('\0')) return null;
    return resolve(assets, path.slice('packages/'.length));
  } catch { return null; }
}

export function projectAvatarRules(id: string, rules: AgentAvatarRules): AgentAvatarRules {
  const project = (state: string, url: string, desktop = false) => {
    const version = new URL(url, 'http://studio.invalid').searchParams.get('v');
    const query = new URLSearchParams();
    if (version) query.set('v', version);
    if (desktop) query.set('variant', 'desktop');
    return `/api/agents/${encodeURIComponent(id)}/avatar/${encodeURIComponent(state)}?${query}`;
  };
  return { ...rules, states: Object.fromEntries(Object.entries(rules.states).map(([key, state]) => [key, {
    ...state, url: project(key, state.url),
    ...(state.desktopUrl ? { desktopUrl: project(key, state.desktopUrl, true) } : {}),
  }])) };
}

export function createAgentAvatarMediaRouter(list: () => readonly AvatarAgent[], assets: () => string): Hono {
  const router = new Hono();
  router.get('/:id/avatar/:state', async (c) => {
    const agent = list().find((entry) => entry.definition.id === c.req.param('id'));
    const states = agent?.definition.avatarRules?.states;
    const key = c.req.param('state');
    const state = states && Object.hasOwn(states, key) ? states[key] : undefined;
    const variant = c.req.query('variant');
    if (variant && variant !== 'desktop') return c.notFound();
    const url = variant === 'desktop' ? state?.desktopUrl : state?.url;
    const path = url ? registeredMediaPath(url, assets()) : null;
    if (!path || !/\.(?:webm|mov|mp4)$/i.test(path)) return c.notFound();
    const file = Bun.file(path);
    if (!(await file.exists())) return c.notFound();
    return new Response(file, { headers: { 'Content-Type': /\.mov$/i.test(path) ? 'video/quicktime' : /\.webm$/i.test(path) ? 'video/webm' : 'video/mp4', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  });
  return router;
}
