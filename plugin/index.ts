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
    const { asker, model, ollamaModel, ollamaTimeoutMs, ollamaUrl, minReductionRatio, apiKey, ...rest } =
      (ctx.options ?? {}) as PluginOptions;
    const judge = makeAsker({ ...rest, asker, model, ollamaModel, ollamaTimeoutMs, ollamaUrl, apiKey });
    const floor = minReductionRatio ?? DEFAULTS.minReductionRatio;
    const storeKey = (sessionID: string) => `session/${sessionID}`;

    await ctx.session.hook('compaction', async (event) => {
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
