import { Plugin } from '@opencode/plugin';
import {
  JevClient,
  buildJevRequest,
  collectToolCalls,
  compact,
  parseJevResponse,
  reductionRatio,
  resolveOptions,
} from 'fast-compaction';
import type { CompactOptions, JevAsker, JevQuestions, JevResponse, JevState } from 'fast-compaction';
import { applyOcDecisions, markerSummary, restoreMessages, toFcMessages, type OcMessage } from './adapter.js';
import {
  FLOOD_DEFAULTS,
  freshLoop,
  recordCall,
  recordCompaction,
  shouldDeny,
  type FloodOptions,
  type LoopState,
} from './guards.js';

const DEFAULTS = {
  ollamaModel: 'clef-flash',
  ollamaTimeoutMs: 600_000,
  ollamaUrl: 'http://localhost:11434/v1/systemone',
  minReductionRatio: 0.25,
} as const;

interface PluginOptions extends CompactOptions {
  asker?: 'cloud' | 'ollama';
  apiKey?: string;
  model?: string;
  ollamaModel?: string;
  ollamaTimeoutMs?: number;
  ollamaUrl?: string;
  minReductionRatio?: number;
  floodWindowMs?: number;
  floodMinCompactions?: number;
  floodMinCallsSinceCompact?: number;
  toolCallLimit?: number;
  toolCallWindowMs?: number;
}

function makeAsker(options: PluginOptions): JevAsker {
  if (options.asker === 'cloud') {
    // JevClient reads TYPESAFE_API_KEY itself; an explicit apiKey wins.
    return new JevClient({ apiKey: options.apiKey, model: options.model });
  }
  const apiKey = options.apiKey ?? 'ollama';
  const model = options.ollamaModel ?? DEFAULTS.ollamaModel;
  const baseUrl = options.ollamaUrl ?? DEFAULTS.ollamaUrl;
  const timeoutMs = options.ollamaTimeoutMs ?? DEFAULTS.ollamaTimeoutMs;
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const built = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body: built.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}

export default Plugin.define({
  id: 'fast-compaction',
  async setup(ctx) {
    const {
      asker,
      model,
      ollamaModel,
      ollamaTimeoutMs,
      ollamaUrl,
      minReductionRatio,
      apiKey,
      floodWindowMs,
      floodMinCompactions,
      floodMinCallsSinceCompact,
      toolCallLimit,
      toolCallWindowMs,
      ...rest
    } = (ctx.options ?? {}) as PluginOptions;
    const judge = makeAsker({ ...rest, asker, model, ollamaModel, ollamaTimeoutMs, ollamaUrl, apiKey });
    const floor = minReductionRatio ?? DEFAULTS.minReductionRatio;
    const storeKey = (sessionID: string) => `session/${sessionID}`;
    const num = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const flood: FloodOptions = {
      floodWindowMs: num(floodWindowMs, FLOOD_DEFAULTS.floodWindowMs),
      // clamped to >=1 like the hook: 0 would make the thrash condition
      // vacuously true and degrade the guard to a raw call limiter
      floodMinCompactions: Math.max(1, num(floodMinCompactions, FLOOD_DEFAULTS.floodMinCompactions)),
      floodMinCallsSinceCompact: Math.max(
        1,
        num(floodMinCallsSinceCompact, FLOOD_DEFAULTS.floodMinCallsSinceCompact),
      ),
      toolCallLimit: num(toolCallLimit, FLOOD_DEFAULTS.toolCallLimit),
      toolCallWindowMs: num(toolCallWindowMs, FLOOD_DEFAULTS.toolCallWindowMs),
    };
    const loops = new Map<string, LoopState>();
    const loopOf = (sessionID: string) => {
      const loop = loops.get(sessionID) ?? freshLoop();
      loops.set(sessionID, loop);
      return loop;
    };

    // Effect-based flood guard: deny a tool only when its loop is thrashing.
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        editor.update(tool.id, (definition) => {
          const execute = definition.execute;
          if (!execute) return;
          definition.execute = async (input, context) => {
            const loop = loopOf(context.sessionID);
            const deny = shouldDeny(loop, tool.id, flood);
            if (deny) throw new Error(deny);
            recordCall(loop, tool.id);
            return execute(input, context);
          };
        });
      }
    });

    await ctx.session.hook('compaction', async (event) => {
      const loop = loopOf(event.sessionID);
      recordCompaction(loop);
      try {
        const stored = (await ctx.storage.get(storeKey(event.sessionID))) as OcMessage[] | undefined;
        const incoming = (
          stored ? restoreMessages(stored, event.messages as OcMessage[]) : event.messages
        ) as OcMessage[];
        const fc = toFcMessages(incoming);
        const result = await compact(fc, judge, rest);
        if (reductionRatio(result) < floor) return; // below the floor: keep the native summary
        const resolved = resolveOptions(rest);
        const calls = collectToolCalls(
          fc,
          resolved.preserveRecentMessages,
          resolved.strip,
          resolved.preserveStartMessages,
        );
        const kept = applyOcDecisions(
          incoming,
          result.decisions,
          calls,
          resolved.truncateHeadChars,
          result.messageDecisions,
        );
        await ctx.storage.set(storeKey(event.sessionID), kept as unknown as Parameters<typeof ctx.storage.set>[1]);
        event.result = { summary: markerSummary(result.stats) };
      } catch {
        // judge failure or malformed answers: fall back to the native summary
      }
    });

    await ctx.session.hook('context', async (event) => {
      const stored = (await ctx.storage.get(storeKey(event.sessionID))) as OcMessage[] | undefined;
      if (!stored) return;
      event.messages = restoreMessages(stored, event.messages as OcMessage[]) as typeof event.messages;
    });
  },
});
