import type {
  JevAnswer,
  JevAsker,
  JevQuestion,
  JevQuestions,
  JevResponse,
  JevState,
} from './types.js';

/**
 * Provider ids accepted by `FASTCOMP_PROVIDER` and `JudgeConfig.provider`.
 * The adapters for these register themselves in the provider registry.
 */
export const JUDGE_PROVIDER_IDS = [
  'jev',
  'clef',
  'ms-decision',
  'ollama',
  'openai-compatible',
] as const;

export type JudgeProviderId = (typeof JUDGE_PROVIDER_IDS)[number];

/** Env vars that override judge config; explicit options win over env. */
export const FASTCOMP_PROVIDER_ENV = 'FASTCOMP_PROVIDER';
export const FASTCOMP_MODEL_ENV = 'FASTCOMP_MODEL';
export const FASTCOMP_BASE_URL_ENV = 'FASTCOMP_BASE_URL';
export const FASTCOMP_API_KEY_ENV = 'FASTCOMP_API_KEY';

/** The provider selection and endpoint knobs every adapter understands. */
export interface JudgeConfig {
  provider: JudgeProviderId;
  /** Judge model name; interpretation is provider-specific. */
  model?: string;
  /** Judge endpoint; adapters own their per-provider default. */
  baseUrl?: string;
  /** Judge credential; the jev provider falls back to `TYPESAFE_API_KEY`. */
  apiKey?: string;
}

/** Partial `JudgeConfig`: everything may come from env or the default. */
export interface JudgeConfigOverrides {
  provider?: JudgeProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** What a provider factory receives: resolved config plus the transport. */
export interface JudgeProviderContext {
  config: JudgeConfig;
  fetch: typeof fetch;
}

/** Builds the `Judge` for one provider id; adapters register these. */
export type JudgeProviderFactory = (context: JudgeProviderContext) => JevAsker;

/**
 * Generic names for the Jev wire types the `Judge` seam speaks. Adapters
 * translate provider-specific payloads into these.
 */
export type JudgeState = JevState;
export type JudgeQuestion = JevQuestion;
export type JudgeQuestions = JevQuestions;
export type JudgeAnswer = JevAnswer;
export type JudgeResponse = JevResponse;

/**
 * Folds explicit overrides over `FASTCOMP_*` env vars over the default
 * provider (`jev`). An unknown provider id fails fast, listing the valid
 * ones. `env` is injectable so callers can resolve without touching
 * `process.env`.
 */
export function resolveJudgeConfig(
  overrides: JudgeConfigOverrides = {},
  env: Record<string, string | undefined> = process.env,
): JudgeConfig {
  const provider =
    overrides.provider ?? (env[FASTCOMP_PROVIDER_ENV] as JudgeProviderId | undefined) ?? 'jev';
  if (!JUDGE_PROVIDER_IDS.includes(provider)) {
    throw new Error(
      `${FASTCOMP_PROVIDER_ENV} must be one of ${JUDGE_PROVIDER_IDS.join('|')}, got "${provider}"`,
    );
  }
  return {
    provider,
    model: overrides.model ?? env[FASTCOMP_MODEL_ENV],
    baseUrl: overrides.baseUrl ?? env[FASTCOMP_BASE_URL_ENV],
    apiKey: overrides.apiKey ?? env[FASTCOMP_API_KEY_ENV],
  };
}

const registry = new Map<JudgeProviderId, JudgeProviderFactory>();

/**
 * Registers the factory for a provider id. A second registration for the
 * same id throws: silent replacement would hide which adapter actually
 * serves the judge.
 */
export function registerJudgeProvider(
  id: JudgeProviderId,
  factory: JudgeProviderFactory,
): void {
  if (registry.has(id)) {
    throw new Error(`judge provider "${id}" is already registered`);
  }
  registry.set(id, factory);
}

/** Ids with a registered factory, in `JUDGE_PROVIDER_IDS` order. */
export function registeredJudgeProviders(): JudgeProviderId[] {
  return JUDGE_PROVIDER_IDS.filter((id) => registry.has(id));
}

/**
 * Resolves the config from overrides + env, looks the provider up in the
 * registry and builds the judge. Creating is the fail-fast point: an
 * unregistered provider throws here, naming what IS registered.
 */
export function createJudge(
  overrides: JudgeConfigOverrides = {},
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): JevAsker {
  const config = resolveJudgeConfig(overrides, env);
  const factory = registry.get(config.provider);
  if (!factory) {
    throw new Error(
      registeredJudgeProviders().length > 0
        ? `judge provider "${config.provider}" is not registered; registered: ${registeredJudgeProviders().join(', ')}`
        : `judge provider "${config.provider}" is not registered; no providers registered`,
    );
  }
  return factory({ config, fetch: fetchImpl });
}
