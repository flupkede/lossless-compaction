import type { JudgeProviderFactory, JudgeProviderId } from '../judge.js';
import { registerJudgeProvider, registeredJudgeProviders } from '../judge.js';
import {
  CLEF_DEFAULT_MODEL,
  createClefJudge,
} from './clef.js';
import {
  chatCompletionsUrl,
  createChatCompletionsJudge,
  extractJson,
  toAnswers,
} from './chat.js';
import { createJevJudge } from './jev.js';
import {
  createMsDecisionJudge,
  fromDecisionAnswers,
  MS_DECISION_DEFAULT_BASE_URL,
  toDecisionQuestions,
} from './ms-decision.js';
import {
  createOllamaJudge,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from './ollama.js';
import { createOpenAICompatibleJudge } from './openai-compatible.js';
import { JUDGE_SYSTEM_PROMPT } from './prompt.js';

export {
  JUDGE_SYSTEM_PROMPT,
  extractJson,
  toAnswers,
  chatCompletionsUrl,
  createChatCompletionsJudge,
  createJevJudge,
  CLEF_DEFAULT_MODEL,
  createClefJudge,
  MS_DECISION_DEFAULT_BASE_URL,
  createMsDecisionJudge,
  toDecisionQuestions,
  fromDecisionAnswers,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  createOllamaJudge,
  createOpenAICompatibleJudge,
};
export type {
  DecisionQuestion,
  DecisionPredicateQuestion,
  DecisionChoiceQuestion,
  DecisionScoreQuestion,
  DecisionAnswer,
} from './ms-decision.js';

/** Every bundled adapter, in `JUDGE_PROVIDER_IDS` order. */
const ADAPTERS: Array<[JudgeProviderId, JudgeProviderFactory]> = [
  ['jev', createJevJudge],
  ['clef', createClefJudge],
  ['ms-decision', createMsDecisionJudge],
  ['ollama', createOllamaJudge],
  ['openai-compatible', createOpenAICompatibleJudge],
];

/**
 * Registers all five adapters with the provider registry. Safe to call
 * repeatedly (an already-registered id is skipped) so plugin shells and
 * scripts can call it unconditionally at startup; `createJudge` then
 * resolves any provider id from env or options.
 */
export function registerJudgeAdapters(): void {
  for (const [id, factory] of ADAPTERS) {
    if (!registeredJudgeProviders().includes(id)) {
      registerJudgeProvider(id, factory);
    }
  }
}
