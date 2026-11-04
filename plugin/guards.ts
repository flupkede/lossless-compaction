/**
 * Effect-based flood guard, ported from the Claude hook: plain call volume is
 * allowed — deep but healthy reading passes — and a tool is denied only when
 * its loop is thrashing: repeated compactions within floodWindowMs while the
 * same tool keeps refilling the context since the last compaction. An
 * optional raw-count backstop (toolCallLimit) stays off by default.
 */

export interface FloodOptions {
  floodWindowMs: number;
  floodMinCompactions: number;
  floodMinCallsSinceCompact: number;
  /** Hard backstop on raw call count within toolCallWindowMs; 0 disables. */
  toolCallLimit: number;
  toolCallWindowMs: number;
}

export const FLOOD_DEFAULTS: FloodOptions = {
  floodWindowMs: 180_000,
  floodMinCompactions: 2,
  floodMinCallsSinceCompact: 10,
  toolCallLimit: 0,
  toolCallWindowMs: 900_000,
};

export interface LoopState {
  compactions: number[];
  callsByTool: Map<string, number[]>;
}

export function freshLoop(): LoopState {
  return { compactions: [], callsByTool: new Map() };
}

function within(list: number[], windowMs: number, now: number): number[] {
  return list.filter((time) => now - time <= windowMs);
}

/** True when this call must be denied: the loop is thrashing on this tool. */
export function shouldDeny(state: LoopState, tool: string, options: FloodOptions, now = Date.now()): string | undefined {
  const recentCompactions = within(state.compactions, options.floodWindowMs, now);
  const calls = state.callsByTool.get(tool) ?? [];
  const sinceCompaction = state.compactions.at(-1);
  const callsSince = sinceCompaction === undefined ? calls : calls.filter((time) => time > sinceCompaction);
  if (
    recentCompactions.length >= options.floodMinCompactions &&
    callsSince.length >= options.floodMinCallsSinceCompact
  ) {
    return `tool '${tool}' denied: ${callsSince.length} calls since the last of ${recentCompactions.length} compactions within ${Math.round(options.floodWindowMs / 1000)}s — the loop is thrashing; finish a different step or ask the user`;
  }
  if (options.toolCallLimit > 0) {
    const recent = within(calls, options.toolCallWindowMs, now);
    if (recent.length >= options.toolCallLimit) {
      return `tool '${tool}' denied: ${recent.length} calls within ${Math.round(options.toolCallWindowMs / 1000)}s exceeds the toolCallLimit backstop`;
    }
  }
  return undefined;
}

export function recordCall(state: LoopState, tool: string, now = Date.now()): void {
  const calls = state.callsByTool.get(tool) ?? [];
  calls.push(now);
  state.callsByTool.set(tool, calls);
}

export function recordCompaction(state: LoopState, now = Date.now()): void {
  state.compactions.push(now);
}
