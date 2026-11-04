import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opencode/plugin', () => ({ Plugin: { define: (definition: unknown) => definition } }));

const compact = vi.fn();
const reductionRatio = vi.fn();
vi.mock('fast-compaction', () => ({
  JevClient: class {},
  buildJevRequest: vi.fn(),
  collectToolCalls: vi.fn(() => []),
  compact: (...args: unknown[]) => compact(...args),
  parseJevResponse: vi.fn(),
  reductionRatio: (...args: unknown[]) => reductionRatio(...args),
  resolveOptions: vi.fn(() => ({
    preserveRecentMessages: 6,
    preserveStartMessages: 2,
    strip: undefined,
    truncateHeadChars: 300,
  })),
}));

const plugin = (await import('./index.js')).default as {
  id: string;
  setup: (ctx: never) => Promise<void>;
};

function makeCtx(options: Record<string, unknown> = {}, storage = new Map<string, unknown>()) {
  const hooks: Record<string, (event: never) => Promise<void> | void> = {};
  const ctx = {
    options: { ledger: false, ...options },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
    },
    session: {
      hook: async (name: string, handler: (event: never) => Promise<void> | void) => {
        hooks[name] = handler;
      },
    },
    tool: {
      transform: async (mutate: (editor: { list: () => never[]; update: () => void }) => void) => {
        mutate({ list: () => [], update: () => {} });
      },
    },
  };
  return { ctx: ctx as never, hooks, storage };
}

const stats = { messagesBefore: 4, messagesAfter: 2, resultsDropped: 1, callsDropped: 0 };

describe('fast-compaction plugin hooks', () => {
  beforeEach(() => {
    compact.mockReset();
    reductionRatio.mockReset();
  });

  it('stores the kept list and sets a marker summary on success', async () => {
    const { ctx, hooks, storage } = makeCtx();
    await plugin.setup(ctx);
    reductionRatio.mockReturnValue(0.5);
    compact.mockReturnValue({ stats, decisions: [], messageDecisions: [] });
    const event = { sessionID: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    await hooks.compaction(event as never);
    expect(storage.get('session/s1')).toBeDefined();
    expect((event as { result?: { summary: string } }).result?.summary).toMatch(/^\[fast-compaction\]/);
  });

  it('keeps the native summary when the reduction is below the floor', async () => {
    const { ctx, hooks, storage } = makeCtx({ minReductionRatio: 0.75 });
    await plugin.setup(ctx);
    reductionRatio.mockReturnValue(0.5);
    compact.mockReturnValue({ stats, decisions: [], messageDecisions: [] });
    const event = { sessionID: 's1', messages: [] };
    await hooks.compaction(event as never);
    expect(storage.has('session/s1')).toBe(false);
    expect((event as { result?: unknown }).result).toBeUndefined();
  });

  it('keeps the native summary when the judge throws', async () => {
    const { ctx, hooks, storage } = makeCtx();
    await plugin.setup(ctx);
    compact.mockRejectedValue(new Error('judge down'));
    const event = { sessionID: 's1', messages: [] };
    await hooks.compaction(event as never);
    expect(storage.has('session/s1')).toBe(false);
    expect((event as { result?: unknown }).result).toBeUndefined();
  });

  it('context hook is a no-op without a stored list', async () => {
    const { ctx, hooks } = makeCtx();
    await plugin.setup(ctx);
    const incoming = [{ role: 'user', content: [{ type: 'text', text: 'fresh' }] }];
    const event = { sessionID: 's2', messages: incoming };
    await hooks.context(event as never);
    expect(event.messages).toBe(incoming);
  });

  it('context hook restores the stored list and drops the marker', async () => {
    const stored = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'kept' }] }];
    const { ctx, hooks } = makeCtx({}, new Map([['session/s3', stored]]));
    await plugin.setup(ctx);
    const marker = { role: 'user', content: [{ type: 'text', text: '[fast-compaction] compacted' }] };
    const fresh = { id: 'm2', role: 'user', content: [{ type: 'text', text: 'new' }] };
    const event = { sessionID: 's3', messages: [marker, fresh] };
    await hooks.context(event as never);
    expect(event.messages).toHaveLength(2);
    expect(event.messages[0]).toBe(stored[0]);
    expect(event.messages[1]).toBe(fresh);
  });

  it('denies a thrashing tool before execute and records passing calls', async () => {
    const executed = vi.fn();
    let wrapped: ((input: unknown, context: { sessionID: string }) => Promise<unknown>) | undefined;
    const hooks: Record<string, (event: never) => Promise<void> | void> = {};
    const ctx = {
      options: { floodMinCompactions: 1, floodMinCallsSinceCompact: 2 },
      storage: { get: async () => undefined, set: async () => {} },
      session: {
        hook: async (name: string, handler: (event: never) => Promise<void> | void) => {
          hooks[name] = handler;
        },
      },
      tool: {
        transform: async (
          mutate: (editor: {
            list: () => { id: string }[];
            update: (id: string, change: (definition: { execute: unknown }) => void) => void;
          }) => void,
        ) => {
          mutate({
            list: () => [{ id: 'dam_browser' }],
            update: (_id, change) => {
              const definition = {
                execute: async () => {
                  executed();
                  return 'ok';
                },
              };
              const original = definition.execute;
              change(definition);
              expect(definition.execute).not.toBe(original); // guard installed
              wrapped = definition.execute as typeof wrapped;
            },
          });
        },
      },
    };
    await plugin.setup(ctx as never);
    compact.mockReturnValue({ stats, decisions: [], messageDecisions: [] });
    await hooks.compaction({ sessionID: 's9', messages: [] } as never);
    await wrapped!({}, { sessionID: 's9' });
    await wrapped!({}, { sessionID: 's9' });
    expect(executed).toHaveBeenCalledTimes(2);
    await expect(wrapped!({}, { sessionID: 's9' })).rejects.toThrow('denied');
    expect(executed).toHaveBeenCalledTimes(2); // deny happens before execute
  });
});
