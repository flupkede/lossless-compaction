import { describe, expect, it } from 'vitest';

import { FLOOD_DEFAULTS, freshLoop, recordCall, recordCompaction, shouldDeny } from './guards.js';

const now = 1_000_000;

describe('flood guard', () => {
  it('allows healthy deep reading (many calls, no compactions)', () => {
    const state = freshLoop();
    for (let i = 0; i < 50; i += 1) recordCall(state, 'read', now + i);
    expect(shouldDeny(state, 'read', FLOOD_DEFAULTS, now + 60_000)).toBeUndefined();
  });

  it('denies only when the loop thrashes: repeated compactions plus refills', () => {
    const state = freshLoop();
    recordCompaction(state, now);
    recordCompaction(state, now + 10_000);
    for (let i = 0; i < 12; i += 1) recordCall(state, 'dam_browser', now + 11_000 + i);
    const verdict = shouldDeny(state, 'dam_browser', FLOOD_DEFAULTS, now + 20_000);
    expect(verdict).toContain('thrashing');
  });

  it('does not deny a different tool in the same thrashing loop', () => {
    const state = freshLoop();
    recordCompaction(state, now);
    recordCompaction(state, now + 10_000);
    for (let i = 0; i < 12; i += 1) recordCall(state, 'dam_browser', now + 11_000 + i);
    expect(shouldDeny(state, 'read', FLOOD_DEFAULTS, now + 20_000)).toBeUndefined();
  });

  it('ignores calls from before the last compaction', () => {
    const state = freshLoop();
    for (let i = 0; i < 12; i += 1) recordCall(state, 'dam_browser', now + i);
    recordCompaction(state, now + 100);
    recordCompaction(state, now + 10_000);
    expect(shouldDeny(state, 'dam_browser', FLOOD_DEFAULTS, now + 20_000)).toBeUndefined();
  });

  it('raw backstop denies at the limit when enabled', () => {
    const state = freshLoop();
    for (let i = 0; i < 5; i += 1) recordCall(state, 'read', now + i);
    const verdict = shouldDeny(state, 'read', { ...FLOOD_DEFAULTS, toolCallLimit: 5 }, now + 1000);
    expect(verdict).toContain('toolCallLimit');
  });
});
