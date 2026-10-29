import { FASTCOMP_API_KEY_ENV, FASTCOMP_MODEL_ENV } from '../judge.js';
import type { JudgeProviderContext } from '../judge.js';
import type {
  ChoiceAnswer,
  JevAsker,
  JevAnswer,
  JevQuestions,
  JevResponse,
  ScoreAnswer,
} from '../types.js';

/** Default endpoint of the OpenAI Decisions route (`{base}/decisions`). */
export const MS_DECISION_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface DecisionPredicateQuestion {
  name: string;
  type: 'predicate';
  instructions: string;
}

export interface DecisionChoiceQuestion {
  name: string;
  type: 'choice';
  instructions: string;
  choices: Array<{ value: string; description?: string }>;
}

export interface DecisionScoreQuestion {
  name: string;
  type: 'score';
  instructions: string;
  levels: Array<{ label: string }>;
}

export type DecisionQuestion =
  | DecisionPredicateQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;

export interface DecisionAnswer {
  name: string;
  type: 'predicate' | 'choice' | 'score' | 'refusal';
  probability?: number;
  choice?: string | boolean;
  score?: number;
  confidence?: number;
  probabilities?: Array<{
    value?: string | boolean | number;
    label?: string;
    probability: number;
  }>;
  message?: string;
}

/**
 * Maps Jev questions onto OpenAI Decisions questions: `noul` becomes a
 * predicate (its criteria fold into the instructions — the Decisions
 * predicate has no separate criteria field), `choice` maps its criteria
 * entries onto typed choices, `score` onto levels.
 */
export function toDecisionQuestions(questions: JevQuestions): DecisionQuestion[] {
  return Object.entries(questions).map(([name, question]) => {
    if (question.type === 'noul') {
      const { criteria } = question;
      const instructions =
        criteria && (criteria.true !== undefined || criteria.false !== undefined)
          ? `${question.instructions} (true: ${criteria.true ?? 'keep'}; false: ${criteria.false ?? 'drop'})`
          : question.instructions;
      return { name, type: 'predicate' as const, instructions };
    }
    if (question.type === 'choice') {
      return {
        name,
        type: 'choice' as const,
        instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) =>
          description ? { value, description } : { value },
        ),
      };
    }
    return {
      name,
      type: 'score' as const,
      instructions: question.instructions,
      levels: question.criteria.map((label) => ({ label })),
    };
  });
}

/**
 * Maps the Decisions answers array (keyed by `name`) back onto the Jev
 * answer shape. A missing answer or a refusal throws: the protocol answers
 * every question, so silence means the response is unusable, and a neutral
 * 0.5 would mask it.
 */
export function fromDecisionAnswers(
  questions: JevQuestions,
  answers: DecisionAnswer[],
): Record<string, JevAnswer> {
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  return Object.fromEntries(
    Object.keys(questions).map((id) => {
      const answer = byName.get(id);
      if (!answer) {
        throw new Error(`judge response is missing an answer for "${id}"`);
      }
      if (answer.type === 'refusal') {
        throw new Error(`judge refused "${id}"${answer.message ? `: ${answer.message}` : ''}`);
      }
      if (answer.type === 'predicate') {
        if (typeof answer.probability !== 'number') {
          throw new Error(`judge answer for "${id}" has no probability`);
        }
        return [id, { type: 'noul', noul: answer.probability } satisfies JevAnswer];
      }
      if (answer.type === 'choice') {
        const mapped: ChoiceAnswer = {
          type: 'choice',
          choice: String(answer.choice),
          confidence: answer.confidence ?? 0,
          probabilities: Object.fromEntries(
            (answer.probabilities ?? []).map((p) => [String(p.value), p.probability]),
          ),
        };
        return [id, mapped satisfies JevAnswer];
      }
      const mapped: ScoreAnswer = {
        type: 'score',
        score: answer.score ?? 0,
        confidence: answer.confidence ?? 0,
        probabilities: Object.fromEntries(
          (answer.probabilities ?? []).map((p) => [String(p.label), p.probability]),
        ),
      };
      return [id, mapped satisfies JevAnswer];
    }),
  );
}

/**
 * The ms-decision provider: OpenAI Decisions (`POST {base}/decisions`, the
 * wire shape of @opencode/ai 2.x's `openai-decisions` route). The state goes
 * in as one json/text input part, the questions as typed decision questions.
 * Needs a model and an API key — there is no sensible default for either.
 */
export function createMsDecisionJudge({ config, fetch }: JudgeProviderContext): JevAsker {
  if (!config.model) {
    throw new Error(
      `${FASTCOMP_MODEL_ENV} (or the model option) is required for the ms-decision provider`,
    );
  }
  if (!config.apiKey) {
    throw new Error(
      `${FASTCOMP_API_KEY_ENV} (or the apiKey option) is required for the ms-decision provider`,
    );
  }
  const url = `${(config.baseUrl ?? MS_DECISION_DEFAULT_BASE_URL).replace(/\/+$/, '')}/decisions`;
  return {
    async ask(state, questions) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: [
            {
              role: 'user',
              content: [
                typeof state === 'string'
                  ? { type: 'input_text', text: state }
                  : { type: 'input_json', data: state },
              ],
            },
          ],
          questions: toDecisionQuestions(questions),
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`judge request failed (${response.status}): ${text.slice(0, 200)}`);
      }
      let parsed: {
        answers?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          inputTokens?: unknown;
          outputTokens?: unknown;
        };
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('judge returned malformed JSON');
      }
      if (!Array.isArray(parsed.answers)) {
        throw new Error('judge response is missing answers');
      }
      const result: JevResponse = {
        answers: fromDecisionAnswers(questions, parsed.answers as DecisionAnswer[]),
      };
      const { usage } = parsed;
      const inputTokens = usage?.input_tokens ?? usage?.inputTokens;
      const outputTokens = usage?.output_tokens ?? usage?.outputTokens;
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
