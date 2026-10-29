import type { JudgeProviderContext } from '../judge.js';
import { buildJevRequest, parseJevResponse, SYSTEM_ONE_URL } from '../request.js';
import type { JevAsker } from '../types.js';

/** Model asked when the config names none; mirrors `jev-latest` for the clef family. */
export const CLEF_DEFAULT_MODEL = 'clef-latest';

/**
 * The clef provider: the same System One wire protocol as jev, for the
 * clef-arch decision models (self-hosted via ollama's `/v1/systemone` or the
 * Typesafe endpoint). Unlike jev there is no `TYPESAFE_API_KEY` fallback —
 * a self-hosted clef needs no key, so the authorization header is simply
 * omitted when none is configured.
 */
export function createClefJudge({ config, fetch }: JudgeProviderContext): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest(
        {
          apiKey: config.apiKey ?? '',
          model: config.model ?? CLEF_DEFAULT_MODEL,
          baseUrl: config.baseUrl ?? SYSTEM_ONE_URL,
        },
        state,
        questions,
      );
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}
