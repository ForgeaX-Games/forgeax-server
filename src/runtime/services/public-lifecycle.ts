export type ServerLifecycleState = 'created' | 'starting' | 'ready' | 'stopping' | 'stopped';

export type PublicServerLifecycle = {
  readonly state: ServerLifecycleState;
  start(): ServerLifecycleState;
  stop(): ServerLifecycleState;
};

export function createPublicServerLifecycle(): PublicServerLifecycle {
  let state: ServerLifecycleState = 'created';
  return {
    get state() { return state; },
    start() {
      if (state !== 'created' && state !== 'stopped') throw new Error(`SERVER_START_INVALID:${state}`);
      state = 'starting';
      state = 'ready';
      return state;
    },
    stop() {
      if (state !== 'ready') throw new Error(`SERVER_STOP_INVALID:${state}`);
      state = 'stopping';
      state = 'stopped';
      return state;
    },
  };
}
