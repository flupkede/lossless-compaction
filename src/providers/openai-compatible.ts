import type { JudgeProviderContext } from '../judge.js';
import type { JevAsker } from '../types.js';
import { createChatCompletionsJudge } from './chat.js';

/**
 * The generic openai-compatible provider: any chat-completions endpoint,
 * including z.ai (`FASTCOMP_BASE_URL=https://api.z.ai/api/paas/v4`). No
 * defaults: base URL, model and (for hosted endpoints) API key must come
 * from config or env, and creation fails fast naming what is missing.
 */
export function createOpenAICompatibleJudge({ config, fetch }: JudgeProviderContext): JevAsker {
  return createChatCompletionsJudge(config, fetch);
}
