import type { JudgeConfig } from '../judge.js';
import { FASTCOMP_BASE_URL_ENV, FASTCOMP_MODEL_ENV } from '../judge.js';
import type { JevAsker, JevQuestions, JevResponse } from '../types.js';
import { JUDGE_SYSTEM_PROMPT } from './prompt.js';

/** Strips Qwen3 reasoning blocks; parses the first *balanced* JSON object,
 * ignoring whatever the model appended after it (observed live: an echoed
 * second object made first-brace-to-last-brace span both and fail). */
export function extractJson(text: string): unknown {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('student reply has no JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}' && (depth -= 1) === 0) {
      return JSON.parse(clean.slice(start, i + 1));
    }
  }
  throw new Error('student reply has no balanced JSON object');
}

/** Maps the student's reply onto every question id; missing/unparseable -> 0.5. */
export function toAnswers(questions: JevQuestions, reply: unknown): JevResponse {
  const parsed = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  const answers: JevResponse['answers'] = {};
  for (const id of Object.keys(questions)) {
    const value = (parsed as Record<string, { noul?: unknown }>)[id]?.noul;
    const noul = typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    answers[id] = { type: 'noul', noul };
  }
  return { answers };
}

/** Joins the OpenAI-compatible base URL with the chat completions path. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * Threshold sent with every payload: the system prompt promises the field
 * and the student was fine-tuned on it, so omitting it would put every
 * request off the training distribution. The seam carries no live value
 * (`keepThreshold` stays adapter-side), matching the shim's default.
 */
export const CHAT_JUDGE_KEEP_THRESHOLD = 0.5;

/**
 * The shared judge over any OpenAI-compatible chat completions endpoint:
 * system prompt + {state, questions} payload in, noul JSON out. Ollama and
 * the generic openai-compatible provider (z.ai and friends) both sit on
 * this; the model speaks the protocol the student was trained on, so the
 * translation matches the systemone shim exactly.
 *
 * `baseUrl` and `model` are required (the provider defaults fill them for
 * ollama); creation fails fast naming the env var or plugin option.
 */
export function createChatCompletionsJudge(
  config: JudgeConfig,
  fetcher: typeof fetch,
): JevAsker {
  if (!config.baseUrl) {
    throw new Error(
      `${FASTCOMP_BASE_URL_ENV} (or the baseUrl option) is required for the ${config.provider} provider`,
    );
  }
  if (!config.model) {
    throw new Error(
      `${FASTCOMP_MODEL_ENV} (or the model option) is required for the ${config.provider} provider`,
    );
  }
  const url = chatCompletionsUrl(config.baseUrl);
  return {
    async ask(state, questions) {
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ state, questions, keepThreshold: CHAT_JUDGE_KEEP_THRESHOLD }) },
          ],
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`judge request failed (${response.status}): ${text.slice(0, 200)}`);
      }
      let parsed: {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('judge returned malformed JSON');
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('judge response has no message content');
      }
      const result = toAnswers(questions, extractJson(content));
      const { usage } = parsed;
      const inputTokens = usage?.prompt_tokens;
      const outputTokens = usage?.completion_tokens;
      if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
        result.usage = {
          ...(typeof inputTokens === 'number' ? { input_tokens: inputTokens } : {}),
          ...(typeof outputTokens === 'number' ? { output_tokens: outputTokens } : {}),
        };
      }
      return result;
    },
  };
}
