import { truncatedResultText } from '../src/compact.js';
import type { CallDecision, Message, MessageDecision, ToolCall } from '../src/types.js';

/**
 * OpenCode model-request shapes (verified against a live v2.2.5 session):
 * assistant `{type:'tool-call', id, name, input}`, results in a following
 * `{role:'tool'}` message as `{type:'tool-result', id, name, result:{type:'text', value}}`.
 */
export interface OcPart {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  result?: { type?: string; value?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface OcMessage {
  id?: string;
  role: string;
  content?: OcPart[];
  [key: string]: unknown;
}

export const SUMMARY_PREFIX = '[fast-compaction]';

function partsOf(message: OcMessage): OcPart[] {
  return Array.isArray(message.content) ? message.content : [];
}

function textOf(parts: readonly OcPart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

function resultValue(part: OcPart): string {
  const value = part.result?.value;
  if (typeof value === 'string') return value;
  return value === undefined ? '' : JSON.stringify(value);
}

/** Index-aligned: oc[i] is judged as fc[i]; `role:'tool'` maps to a user result holder. */
export function toFcMessages(messages: readonly OcMessage[]): Message[] {
  return messages.map((message) => {
    const parts = partsOf(message);
    const fc: Message = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: textOf(parts),
      toolUses: parts
        .filter((part) => part.type === 'tool-call')
        .map((part) => ({
          tool_use_id: part.id ?? '',
          tool: part.name ?? '',
          input: (part.input ?? {}) as Record<string, unknown>,
        })),
    };
    const results = parts.filter((part) => part.type === 'tool-result');
    if (results.length > 0) {
      fc.toolResults = results.map((part) => ({ tool_use_id: part.id ?? '', text: resultValue(part) }));
    }
    return fc;
  });
}

export { truncatedResultText };

/**
 * Rebuilds the OpenCode message list from judge decisions. Untouched messages
 * come back as the same objects; a dropped call takes its result with it; a
 * dropped result keeps a bounded head and note; a prose-dropped assistant
 * keeps its kept calls and loses text and reasoning.
 */
export function applyOcDecisions(
  messages: readonly OcMessage[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  messageDecisions: readonly MessageDecision[] = [],
): OcMessage[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const proseDropped = new Set(messageDecisions.filter((decision) => !decision.keep).map((decision) => decision.i));
  const kept: OcMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const parts = partsOf(message);
    const proseDroppedHere = proseDropped.has(index);
    const touched =
      proseDroppedHere ||
      parts.some(
        (part) => (part.type === 'tool-call' || part.type === 'tool-result') && part.id && actions.has(part.id),
      );
    if (!touched) {
      kept.push(message);
      continue;
    }
    if (proseDroppedHere) {
      const callsLeft = parts.filter(
        (part) => part.type === 'tool-call' && (!part.id || actions.get(part.id) !== 'drop_call'),
      );
      if (callsLeft.length === 0) continue;
      kept.push({ ...message, content: callsLeft });
      continue;
    }
    let changed = false;
    const content: OcPart[] = [];
    for (const part of parts) {
      const action = part.id ? actions.get(part.id) : undefined;
      if ((part.type === 'tool-call' || part.type === 'tool-result') && action === 'drop_call') {
        changed = true;
        continue;
      }
      if (part.type === 'tool-result' && action === 'drop_result') {
        changed = true;
        const value = resultValue(part);
        content.push({
          ...part,
          result: { ...part.result, type: 'text', value: truncatedResultText(value, false, headChars) },
        });
        continue;
      }
      content.push(part);
    }
    // fc semantics: a message whose text and calls are gone is gone; a
    // reasoning-only remainder belongs to the dropped call, not the transcript
    const meaningful = content.some((part) => part.type === 'text' || part.type === 'tool-call');
    if (message.role === 'assistant' && !meaningful) continue;
    if (content.length === 0) continue;
    kept.push(changed ? { ...message, content } : message);
  }
  return kept;
}

export function markerSummary(stats: {
  messagesBefore: number;
  messagesAfter: number;
  resultsDropped: number;
  callsDropped: number;
}): string {
  return (
    `${SUMMARY_PREFIX} compacted: ${stats.messagesAfter} of ${stats.messagesBefore} messages kept verbatim` +
    ` (${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped).` +
    ' The plugin restores the kept transcript verbatim on every model call.'
  );
}

export function isMarkerSummary(message: OcMessage): boolean {
  return message.role === 'user' && textOf(partsOf(message)).startsWith(SUMMARY_PREFIX);
}

/** Stored verbatim list + everything new; markers and id duplicates dropped. */
export function restoreMessages(
  stored: readonly OcMessage[],
  incoming: readonly OcMessage[],
): OcMessage[] {
  const ids = new Set(stored.map((message) => message.id).filter(Boolean) as string[]);
  const tail = incoming.filter(
    (message) => !isMarkerSummary(message) && !(message.id && ids.has(message.id)),
  );
  return [...stored, ...tail];
}
