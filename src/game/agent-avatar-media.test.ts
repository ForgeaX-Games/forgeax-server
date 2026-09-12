import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAvatarRules } from '@forgeax/types';
import { createAgentAvatarMediaRouter, projectAvatarRules } from './agent-avatar-media';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'avatar-media-'));roots.push(root);
 mkdirSync(join(root,'packages'));mkdirSync(join(root,'.forgeax'));
 writeFileSync(join(root,'.forgeax','idle.webm'),'video');
 const rules: AgentAvatarRules={default:'idle',fallback:'idle',events:{},priority:{},states:{idle:{state:'idle',url:'/api/files/raw?path=packages%2F..%2F.forgeax%2Fidle.webm&v=1',loop:true,fadeInMs:0}}};
 const agents=[{definition:{id:'mochi',avatarRules:rules}}];
 return {rules,agents,router:createAgentAvatarMediaRouter(()=>agents,()=>join(root,'packages'))};
}
test('serves a registered avatar outside packages without exposing a request path',async()=>{
 const {rules,router}=fixture();const projected=projectAvatarRules('mochi',rules);
 expect(projected.states.idle.url).toBe('/api/agents/mochi/avatar/idle?v=1');
 expect(rules.states.idle.url).toContain('files/raw');
 const r=await router.request('/mochi/avatar/idle?path=/etc/passwd');
 expect(r.status).toBe(200);expect(r.headers.get('content-type')).toBe('video/webm');expect(await r.text()).toBe('video');
});
test('rejects unknown state, agent, variants and removed definitions',async()=>{
 const {router,agents}=fixture();
 for(const path of ['/unknown/avatar/idle','/mochi/avatar/__proto__','/mochi/avatar/missing','/mochi/avatar/idle?variant=other','/mochi/avatar/idle?variant=desktop']) expect((await router.request(path)).status).toBe(404);
 agents.length=0;expect((await router.request('/mochi/avatar/idle')).status).toBe(404);
});
test('does not serve arbitrary remote URLs or non-media registered paths',async()=>{
 const {rules,router}=fixture();
 for(const url of ['https://example.com/api/files/raw?path=packages/x.webm','/api/files/raw?path=/etc/passwd','/api/files/raw?path=packages/secrets.json']) {
 rules.states.idle.url=url;expect((await router.request('/mochi/avatar/idle')).status).toBe(404);
 }
});
