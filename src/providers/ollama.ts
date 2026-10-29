import type { JudgeProviderContext } from '../judge.js';
import type { JevAsker } from '../types.js';
import { createChatCompletionsJudge } from './chat.js';

/**
 * Local ollama serving its OpenAI-compatible endpoint. Plain ollama listens
 * on 11434 — port 11435 is the systemone shim's System One protocol, which
 * no chat-completions request can reach; point FASTCOMP_BASE_URL there only
 * for the jev/clef providers. The default model is the distilled
 * `fast-compaction` student.
 */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const OLLAMA_DEFAULT_MODEL = 'fast-compaction';

/** The ollama provider: chat-completions translation with local defaults. */
export function createOllamaJudge({ config, fetch }: JudgeProviderContext): JevAsker {
  return createChatCompletionsJudge(
    {
      ...config,
      model: config.model ?? OLLAMA_DEFAULT_MODEL,
      baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    },
    fetch,
  );
}
