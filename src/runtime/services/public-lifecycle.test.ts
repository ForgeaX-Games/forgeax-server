import { describe, expect, it } from 'bun:test';
import { createPublicServerLifecycle } from './public-lifecycle';

describe('public server lifecycle', () => {
  it('does not report ready before start and supports restart after stop', () => {
    const lifecycle = createPublicServerLifecycle();
    expect(lifecycle.state).toBe('created');
    expect(lifecycle.start()).toBe('ready');
    expect(lifecycle.stop()).toBe('stopped');
    expect(lifecycle.start()).toBe('ready');
  });

  it('fails closed for invalid lifecycle transitions', () => {
    const lifecycle = createPublicServerLifecycle();
    expect(() => lifecycle.stop()).toThrow('SERVER_STOP_INVALID:created');
    lifecycle.start();
    expect(() => lifecycle.start()).toThrow('SERVER_START_INVALID:ready');
  });
});
