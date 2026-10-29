import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CLEF_DEFAULT_MODEL,
  FASTCOMP_API_KEY_ENV,
  FASTCOMP_BASE_URL_ENV,
  FASTCOMP_MODEL_ENV,
  JUDGE_PROVIDER_IDS,
  JUDGE_SYSTEM_PROMPT,
  MS_DECISION_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  SYSTEM_ONE_URL,
  TYPESAFE_API_KEY_ENV,
  chatCompletionsUrl,
  createJudge,
  registerJudgeAdapters,
  registeredJudgeProviders,
} from '../src/index.js';
import type { JevQuestions, JevResponse } from '../src/index.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Fetch double: records every call, replies with one JSON payload. */
function mockFetch(payload: unknown, status = 200) {
  const calls: CapturedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const QUESTIONS: JevQuestions = {
  q1: { type: 'noul', instructions: 'keep the call?' },
  q2: { type: 'noul', instructions: 'keep the result?' },
};

function noulReply(values: Record<string, number>): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(
            Object.fromEntries(Object.entries(values).map(([id, noul]) => [id, { type: 'noul', noul }])),
          ),
        },
      },
    ],
    usage: { prompt_tokens: 111, completion_tokens: 22 },
  };
}

function requestBody(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const EMPTY_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  registerJudgeAdapters();
});

describe('registerJudgeAdapters', () => {
  it('registers every provider id, in JUDGE_PROVIDER_IDS order', () => {
    expect(registeredJudgeProviders()).toEqual(JUDGE_PROVIDER_IDS);
  });

  it('is idempotent: a second call does not throw or reorder', () => {
    expect(() => registerJudgeAdapters()).not.toThrow();
    expect(registeredJudgeProviders()).toEqual(JUDGE_PROVIDER_IDS);
  });
});

describe('chatCompletionsUrl', () => {
  it('joins the base URL and trims trailing slashes', () => {
    expect(chatCompletionsUrl('http://localhost:11435/v1')).toBe('http://localhost:11435/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.z.ai/api/paas/v4/')).toBe('https://api.z.ai/api/paas/v4/chat/completions');
  });
});

describe('jev adapter', () => {
  it('sends the Jev request with the jev-latest default and a Bearer key', async () => {
    const { impl, calls } = mockFetch({ answers: { q1: { noul: 0.9 } } });
    const judge = createJudge({ provider: 'jev' }, { [FASTCOMP_API_KEY_ENV]: 'k' }, impl);
    const response = await judge.ask('state', QUESTIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SYSTEM_ONE_URL);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer k' });
    const body = requestBody(calls[0]!);
    expect(body).toMatchObject({ model: 'jev-latest', state: 'state' });
    expect(body.questions).toEqual(QUESTIONS);
    expect(response).toEqual({ answers: { q1: { noul: 0.9 } } } satisfies JevResponse);
  });

  it('keeps the TYPESAFE_API_KEY fallback when no FASTCOMP key is set', async () => {
    vi.stubEnv(TYPESAFE_API_KEY_ENV, 'tk');
    try {
      const { impl, calls } = mockFetch({ answers: {} });
      const judge = createJudge({ provider: 'jev' }, EMPTY_ENV, impl);
      await judge.ask('state', {});
      expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer tk' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('throws the client error when neither FASTCOMP_API_KEY nor TYPESAFE_API_KEY is set', async () => {
    vi.stubEnv(TYPESAFE_API_KEY_ENV, '');
    try {
      const { impl } = mockFetch({ answers: {} });
      const judge = createJudge({ provider: 'jev' }, EMPTY_ENV, impl);
      await expect(judge.ask('state', {})).rejects.toThrow(
        `${TYPESAFE_API_KEY_ENV} is not configured`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('clef adapter', () => {
  it('defaults to the System One endpoint with clef-latest and no auth header when keyless', async () => {
    const { impl, calls } = mockFetch({ answers: { q1: { noul: 0.4 } } });
    const judge = createJudge({ provider: 'clef' }, EMPTY_ENV, impl);
    await judge.ask({ context: 'c' }, QUESTIONS);
    expect(calls[0]!.url).toBe(SYSTEM_ONE_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(requestBody(calls[0]!)).toMatchObject({ model: CLEF_DEFAULT_MODEL });
  });

  it('sends Bearer auth once a key is configured and honors a baseUrl override', async () => {
    const { impl, calls } = mockFetch({ answers: {} });
    const judge = createJudge(
      { provider: 'clef' },
      {
        [FASTCOMP_API_KEY_ENV]: 'k',
        [FASTCOMP_BASE_URL_ENV]: 'http://ollama.lan:11434/v1/systemone',
        [FASTCOMP_MODEL_ENV]: 'clef-mix',
      },
      impl,
    );
    await judge.ask('state', QUESTIONS);
    expect(calls[0]!.url).toBe('http://ollama.lan:11434/v1/systemone');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(requestBody(calls[0]!)).toMatchObject({ model: 'clef-mix' });
  });

  it('throws the judge request failure on a non-ok response', async () => {
    const { impl } = mockFetch('boom', 500);
    const judge = createJudge({ provider: 'clef' }, EMPTY_ENV, impl);
    await expect(judge.ask('state', QUESTIONS)).rejects.toThrow('judge request failed (500): boom');
  });
});

describe('ollama adapter', () => {
  it('defaults to localhost:11435/v1 with the fast-compaction student and no auth', async () => {
    const { impl, calls } = mockFetch(noulReply({ q1: 0.9, q2: 0.1 }));
    const judge = createJudge({ provider: 'ollama' }, EMPTY_ENV, impl);
    await judge.ask('state', QUESTIONS);
    expect(calls[0]!.url).toBe(`${OLLAMA_DEFAULT_BASE_URL}/chat/completions`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = requestBody(calls[0]!);
    expect(body).toMatchObject({
      model: OLLAMA_DEFAULT_MODEL,
      stream: false,
      temperature: 0,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ state: 'state', questions: QUESTIONS }) },
    ]);
  });

  it('parses noul answers from the completion content', async () => {
    const { impl } = mockFetch(noulReply({ q1: 0.9, q2: 0.1 }));
    const judge = createJudge({ provider: 'ollama' }, EMPTY_ENV, impl);
    const response = await judge.ask('state', QUESTIONS);
    expect(response.answers).toEqual({
      q1: { type: 'noul', noul: 0.9 },
      q2: { type: 'noul', noul: 0.1 },
    });
    expect(response.usage).toEqual({ input_tokens: 111, output_tokens: 22 });
  });

  it('strips reasoning blocks and trailing text, clamps and falls back to 0.5', async () => {
    const content = '<think>deliberation</think>{"q1":{"noul":1.7},"q2":{"noul":"nope"}} trailing';
    const { impl } = mockFetch({ choices: [{ message: { content } }] });
    const judge = createJudge({ provider: 'ollama' }, EMPTY_ENV, impl);
    const response = await judge.ask('state', QUESTIONS);
    expect(response.answers).toEqual({
      q1: { type: 'noul', noul: 1 },
      q2: { type: 'noul', noul: 0.5 },
    });
  });

  it('honors baseUrl and model overrides and sends Bearer auth when configured', async () => {
    const { impl, calls } = mockFetch(noulReply({ q1: 0.5, q2: 0.5 }));
    const judge = createJudge(
      { provider: 'ollama' },
      {
        [FASTCOMP_BASE_URL_ENV]: 'http://ollama.lan:11434/v1/',
        [FASTCOMP_MODEL_ENV]: 'student',
        [FASTCOMP_API_KEY_ENV]: 'k',
      },
      impl,
    );
    await judge.ask('state', QUESTIONS);
    expect(calls[0]!.url).toBe('http://ollama.lan:11434/v1/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(requestBody(calls[0]!)).toMatchObject({ model: 'student' });
  });

  it('throws on a failed request, malformed JSON and a reply without content', async () => {
    const failing = mockFetch('down', 503);
    await expect(
      createJudge({ provider: 'ollama' }, EMPTY_ENV, failing.impl).ask('s', QUESTIONS),
    ).rejects.toThrow('judge request failed (503): down');

    const malformed = mockFetch('not json');
    await expect(
      createJudge({ provider: 'ollama' }, EMPTY_ENV, malformed.impl).ask('s', QUESTIONS),
    ).rejects.toThrow('judge returned malformed JSON');

    const empty = mockFetch({ choices: [{ message: {} }] });
    await expect(
      createJudge({ provider: 'ollama' }, EMPTY_ENV, empty.impl).ask('s', QUESTIONS),
    ).rejects.toThrow('judge response has no message content');

    const noJson = mockFetch({ choices: [{ message: { content: 'plain text' } }] });
    await expect(
      createJudge({ provider: 'ollama' }, EMPTY_ENV, noJson.impl).ask('s', QUESTIONS),
    ).rejects.toThrow('student reply has no JSON object');
  });
});

describe('openai-compatible adapter', () => {
  it('fails fast without a base URL, naming the env var', () => {
    expect(() => createJudge({ provider: 'openai-compatible' }, EMPTY_ENV)).toThrowError(
      `${FASTCOMP_BASE_URL_ENV} (or the baseUrl option) is required for the openai-compatible provider`,
    );
  });

  it('fails fast without a model, naming the env var', () => {
    expect(() =>
      createJudge(
        { provider: 'openai-compatible' },
        { [FASTCOMP_BASE_URL_ENV]: 'https://api.z.ai/api/paas/v4' },
      ),
    ).toThrowError(
      `${FASTCOMP_MODEL_ENV} (or the model option) is required for the openai-compatible provider`,
    );
  });

  it('speaks chat completions against the configured endpoint with Bearer auth', async () => {
    const { impl, calls } = mockFetch(noulReply({ q1: 0.8, q2: 0.2 }));
    const judge = createJudge(
      { provider: 'openai-compatible' },
      {
        [FASTCOMP_BASE_URL_ENV]: 'https://api.z.ai/api/paas/v4',
        [FASTCOMP_MODEL_ENV]: 'glm-4.7',
        [FASTCOMP_API_KEY_ENV]: 'zk',
      },
      impl,
    );
    const response = await judge.ask('state', QUESTIONS);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer zk' });
    expect(requestBody(calls[0]!)).toMatchObject({ model: 'glm-4.7' });
    expect(response.answers).toEqual({
      q1: { type: 'noul', noul: 0.8 },
      q2: { type: 'noul', noul: 0.2 },
    });
  });
});

describe('ms-decision adapter', () => {
  it('fails fast without a model, then without an API key', () => {
    expect(() => createJudge({ provider: 'ms-decision' }, EMPTY_ENV)).toThrowError(
      `${FASTCOMP_MODEL_ENV} (or the model option) is required for the ms-decision provider`,
    );
    expect(() =>
      createJudge({ provider: 'ms-decision' }, { [FASTCOMP_MODEL_ENV]: 'm' }),
    ).toThrowError(
      `${FASTCOMP_API_KEY_ENV} (or the apiKey option) is required for the ms-decision provider`,
    );
  });

  it('posts the OpenAI Decisions shape to the default endpoint', async () => {
    const { impl, calls } = mockFetch({
      model: 'decision-1',
      answers: [
        { type: 'predicate', name: 'q1', probability: 0.7 },
        { type: 'predicate', name: 'q2', probability: 0.4 },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const judge = createJudge(
      { provider: 'ms-decision' },
      { [FASTCOMP_MODEL_ENV]: 'decision-1', [FASTCOMP_API_KEY_ENV]: 'ok' },
      impl,
    );
    const response = await judge.ask({ context: 'c', history: [] }, QUESTIONS);
    expect(calls[0]!.url).toBe(`${MS_DECISION_DEFAULT_BASE_URL}/decisions`);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer ok' });
    const body = requestBody(calls[0]!);
    expect(body.model).toBe('decision-1');
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_json', data: { context: 'c', history: [] } }],
      },
    ]);
    expect(body.questions).toEqual([
      { name: 'q1', type: 'predicate', instructions: 'keep the call?' },
      { name: 'q2', type: 'predicate', instructions: 'keep the result?' },
    ]);
    expect(response.answers).toEqual({
      q1: { type: 'noul', noul: 0.7 },
      q2: { type: 'noul', noul: 0.4 },
    });
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('sends string states as input_text and folds noul criteria into the instructions', async () => {
    const { impl, calls } = mockFetch({
      answers: [{ type: 'predicate', name: 'q', probability: 0.5 }],
    });
    const judge = createJudge(
      { provider: 'ms-decision' },
      { [FASTCOMP_MODEL_ENV]: 'm', [FASTCOMP_API_KEY_ENV]: 'k' },
      impl,
    );
    await judge.ask('raw state', {
      q: {
        type: 'noul',
        instructions: 'keep?',
        criteria: { true: 'still needed', false: 'redundant' },
      },
    });
    const body = requestBody(calls[0]!);
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'raw state' }] },
    ]);
    expect(body.questions).toEqual([
      { name: 'q', type: 'predicate', instructions: 'keep? (true: still needed; false: redundant)' },
    ]);
  });

  it('maps choice and score questions with their criteria', async () => {
    const { impl, calls } = mockFetch({
      answers: [
        {
          type: 'choice',
          name: 'c',
          choice: 'drop',
          confidence: 0.9,
          probabilities: [
            { value: 'keep', probability: 0.1 },
            { value: 'drop', probability: 0.9 },
          ],
        },
        {
          type: 'score',
          name: 's',
          score: 1,
          confidence: 0.8,
          probabilities: [
            { value: 0, label: 'vital', probability: 0.2 },
            { value: 1, label: 'filler', probability: 0.8 },
          ],
        },
      ],
    });
    const judge = createJudge(
      { provider: 'ms-decision' },
      { [FASTCOMP_MODEL_ENV]: 'm', [FASTCOMP_API_KEY_ENV]: 'k' },
      impl,
    );
    const response = await judge.ask('state', {
      c: {
        type: 'choice',
        instructions: 'pick',
        criteria: { keep: 'stays verbatim', drop: null },
      },
      s: { type: 'score', instructions: 'rate', criteria: ['vital', 'filler'] },
    });
    expect(requestBody(calls[0]!).questions).toEqual([
      {
        name: 'c',
        type: 'choice',
        instructions: 'pick',
        choices: [
          { value: 'keep', description: 'stays verbatim' },
          { value: 'drop' },
        ],
      },
      {
        name: 's',
        type: 'score',
        instructions: 'rate',
        levels: [{ label: 'vital' }, { label: 'filler' }],
      },
    ]);
    expect(response.answers).toEqual({
      c: {
        type: 'choice',
        choice: 'drop',
        confidence: 0.9,
        probabilities: { keep: 0.1, drop: 0.9 },
      },
      s: {
        type: 'score',
        score: 1,
        confidence: 0.8,
        probabilities: { vital: 0.2, filler: 0.8 },
      },
    });
  });

  it('throws on refusals, missing answers, and missing probabilities', async () => {
    const refusal = mockFetch({
      answers: [{ type: 'refusal', name: 'q1', message: 'safety' }],
    });
    await expect(
      createJudge(
        { provider: 'ms-decision' },
        { [FASTCOMP_MODEL_ENV]: 'm', [FASTCOMP_API_KEY_ENV]: 'k' },
        refusal.impl,
      ).ask('s', QUESTIONS),
    ).rejects.toThrow('judge refused "q1": safety');

    const missing = mockFetch({ answers: [{ type: 'predicate', name: 'q2', probability: 0.5 }] });
    await expect(
      createJudge(
        { provider: 'ms-decision' },
        { [FASTCOMP_MODEL_ENV]: 'm', [FASTCOMP_API_KEY_ENV]: 'k' },
        missing.impl,
      ).ask('s', QUESTIONS),
    ).rejects.toThrow('judge response is missing an answer for "q1"');

    const noProbability = mockFetch({
      answers: [{ type: 'predicate', name: 'q1' }],
    });
    await expect(
      createJudge(
        { provider: 'ms-decision' },
        { [FASTCOMP_MODEL_ENV]: 'm', [FASTCOMP_API_KEY_ENV]: 'k' },
        noProbability.impl,
      ).ask('s', QUESTIONS),
    ).rejects.toThrow('judge answer for "q1" has no probability');
  });

  it('joins a baseUrl override with /decisions and trims the trailing slash', async () => {
    const { impl, calls } = mockFetch({ answers: [{ type: 'predicate', name: 'q1', probability: 1 }] });
    const judge = createJudge(
      { provider: 'ms-decision' },
      {
        [FASTCOMP_BASE_URL_ENV]: 'https://gate.example/v1/',
        [FASTCOMP_MODEL_ENV]: 'm',
        [FASTCOMP_API_KEY_ENV]: 'k',
      },
      impl,
    );
    await judge.ask('s', { q1: { type: 'noul', instructions: 'i' } });
    expect(calls[0]!.url).toBe('https://gate.example/v1/decisions');
  });
});
