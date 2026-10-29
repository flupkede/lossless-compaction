import { describe, expect, it } from 'vitest';
import {
  FASTCOMP_API_KEY_ENV,
  FASTCOMP_BASE_URL_ENV,
  FASTCOMP_MODEL_ENV,
  FASTCOMP_PROVIDER_ENV,
  JUDGE_PROVIDER_IDS,
  JevClient,
  createJudge,
  registeredJudgeProviders,
  registerJudgeProvider,
  resolveJudgeConfig,
} from '../src/index.js';
import type {
  Judge,
  JudgeConfigOverrides,
  JudgeProviderContext,
  JudgeProviderFactory,
  JevResponse,
} from '../src/index.js';

const EMPTY_ENV: Record<string, string | undefined> = {};

describe('resolveJudgeConfig', () => {
  it('defaults to the jev provider with no env and no overrides', () => {
    expect(resolveJudgeConfig({}, EMPTY_ENV)).toEqual({ provider: 'jev' });
  });

  it('fills model, baseUrl and apiKey from FASTCOMP_* env vars', () => {
    const config = resolveJudgeConfig(
      {},
      {
        [FASTCOMP_PROVIDER_ENV]: 'ollama',
        [FASTCOMP_MODEL_ENV]: 'fast-compaction',
        [FASTCOMP_BASE_URL_ENV]: 'http://localhost:11435/v1',
        [FASTCOMP_API_KEY_ENV]: 'secret',
      },
    );
    expect(config).toEqual({
      provider: 'ollama',
      model: 'fast-compaction',
      baseUrl: 'http://localhost:11435/v1',
      apiKey: 'secret',
    });
  });

  it('explicit overrides win over env', () => {
    const config = resolveJudgeConfig(
      { provider: 'jev', model: 'jev-latest' },
      {
        [FASTCOMP_PROVIDER_ENV]: 'ollama',
        [FASTCOMP_MODEL_ENV]: 'clef-flash',
      },
    );
    expect(config).toEqual({ provider: 'jev', model: 'jev-latest' });
  });

  it('resolves only from the injected env, never process.env', () => {
    const leaky: Record<string, string | undefined> = {
      ...EMPTY_ENV,
      [FASTCOMP_PROVIDER_ENV]: 'openai-compatible',
    };
    expect(resolveJudgeConfig({}, {}).provider).toBe('jev');
    expect(resolveJudgeConfig({}, leaky).provider).toBe('openai-compatible');
  });

  it('fails fast on an unknown provider id, listing the valid ones', () => {
    expect(() =>
      resolveJudgeConfig({}, { [FASTCOMP_PROVIDER_ENV]: 'gpt4' }),
    ).toThrowError(
      `${FASTCOMP_PROVIDER_ENV} must be one of ${JUDGE_PROVIDER_IDS.join('|')}, got "gpt4"`,
    );
  });
});

describe('provider registry', () => {
  it('reports no providers when nothing is registered', () => {
    expect(registeredJudgeProviders()).toEqual([]);
  });

  it('throws on creating an unregistered provider, naming the registry state', () => {
    expect(() => createJudge({ provider: 'ollama' }, EMPTY_ENV)).toThrowError(
      'judge provider "ollama" is not registered; no providers registered',
    );
  });

  it('builds the judge through the registered factory with resolved config', async () => {
    const captured: JudgeProviderContext[] = [];
    registerJudgeProvider('ollama', (context) => {
      captured.push(context);
      return { ask: async () => ({ answers: {} }) satisfies JevResponse };
    });
    const env = {
      [FASTCOMP_MODEL_ENV]: 'fast-compaction',
      [FASTCOMP_BASE_URL_ENV]: 'http://localhost:11435/v1',
    };
    const judge = createJudge({ provider: 'ollama' }, env);
    expect(registeredJudgeProviders()).toEqual(['ollama']);
    expect(captured).toHaveLength(1);
    const context = captured[0];
    if (!context) throw new Error('factory was not called');
    expect(context.config).toEqual({
      provider: 'ollama',
      model: 'fast-compaction',
      baseUrl: 'http://localhost:11435/v1',
    });
    expect(typeof context.fetch).toBe('function');
    expect(await judge.ask('state', {})).toEqual({ answers: {} });
  });

  it('passes an injected fetch through to the factory', async () => {
    registerJudgeProvider('jev', (context) => ({
      ask: async () => {
        await context.fetch('http://judge.invalid');
        return { answers: {} } satisfies JevResponse;
      },
    }));
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const judge = createJudge({ provider: 'jev' }, EMPTY_ENV, fetchImpl);
    await judge.ask('state', {});
    expect(calls).toEqual(['http://judge.invalid']);
  });

  it('throws on a duplicate registration instead of silently replacing', () => {
    const stub: JudgeProviderFactory = () => ({
      ask: async () => ({ answers: {} }) satisfies JevResponse,
    });
    registerJudgeProvider('ms-decision', stub);
    expect(() => registerJudgeProvider('ms-decision', stub)).toThrowError(
      'judge provider "ms-decision" is already registered',
    );
  });

  it('accepts JevClient as a Judge (seam compatibility)', () => {
    const judge: Judge = new JevClient({ apiKey: 'k' });
    expect(judge).toBeInstanceOf(JevClient);
  });

  it('accepts partial overrides objects at the type level', () => {
    const overrides: JudgeConfigOverrides = { provider: 'clef' };
    expect(resolveJudgeConfig(overrides, EMPTY_ENV).provider).toBe('clef');
  });
});
