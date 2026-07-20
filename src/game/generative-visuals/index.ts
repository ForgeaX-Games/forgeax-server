import { Hono } from 'hono';
import {
  createGenerativeVisualAccessPolicy,
  type GenerativeVisualAccessPolicy,
} from './access-policy';
import { createFluxRtRouter, getFluxRtWsUpstreamUrl } from './fluxrt';
import { createReactorTokenRouter } from './reactor-token-broker';

export { getFluxRtWsUpstreamUrl };
export { ReactorTokenBroker } from './reactor-token-broker';

/**
 * Provider adapters share one Studio-only product boundary, while retaining
 * their own transport: FluxRT uses the server WS relay; Reactor's browser SDK
 * uses a short-lived token then establishes WebRTC directly with Reactor.
 */
export interface GenerativeVisualsRouterOptions {
  readonly accessPolicy?: GenerativeVisualAccessPolicy;
}

export function createGenerativeVisualsRouter(
  options: GenerativeVisualsRouterOptions = {},
): Hono {
  const accessPolicy = options.accessPolicy ?? createGenerativeVisualAccessPolicy();
  const router = new Hono();
  router.route('/fluxrt', createFluxRtRouter({ accessPolicy }));
  router.route('/reactor', createReactorTokenRouter({ accessPolicy }));
  return router;
}
