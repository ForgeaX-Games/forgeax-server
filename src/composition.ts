import type { Hono } from 'hono';
export { registerServerModule } from './composition-host';

export interface ServerCompositionContext {
  app: Hono;
}

export interface ServerModule {
  activate(context: ServerCompositionContext): void | Promise<void>;
}
