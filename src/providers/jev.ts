import { JevClient } from '../client.js';
import type { JudgeProviderContext } from '../judge.js';
import type { JevAsker } from '../types.js';

/**
 * The jev provider: the existing `JevClient` behind the generic seam.
 * Defaults and the `TYPESAFE_API_KEY` fallback stay in the client, so this
 * adapter preserves the pre-registry behaviour one-to-one.
 */
export function createJevJudge({ config, fetch }: JudgeProviderContext): JevAsker {
  return new JevClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    fetch,
  });
}
