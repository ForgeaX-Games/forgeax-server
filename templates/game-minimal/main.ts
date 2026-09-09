import type { BootstrapContext } from '@forgeax/editor-game-plugins';
import type { World } from '@forgeax/engine-ecs';

/** Add game behavior here after authoring persistent scene assets through the Editor Gateway. */
export async function bootstrap(_world: World, _ctx?: BootstrapContext): Promise<void> {}
