import { describe, expect, it } from 'vitest';

import {
  applyOcDecisions,
  isMarkerSummary,
  restoreMessages,
  toFcMessages,
  truncatedResultText,
  type OcMessage,
} from './adapter.js';
import type { CallDecision, MessageDecision, ToolCall } from '../src/types.js';

// Shapes captured live from an OpenCode 2.2.5 compaction hook (spike).
const userMsg: OcMessage = {
  id: 'msg_u1',
  role: 'user',
  content: [{ type: 'text', text: 'read the config' }],
};
const assistantCall: OcMessage = {
  id: 'msg_a1',
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'call read' },
    { type: 'tool-call', id: 'call_1', name: 'read', input: { path: 'x.json' } },
  ],
};
const toolResult: OcMessage = {
  role: 'tool',
  content: [
    { type: 'tool-result', id: 'call_1', name: 'read', result: { type: 'text', value: 'file contents' } },
  ],
};
const assistantText: OcMessage = {
  id: 'msg_a2',
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
};
const oc = [userMsg, assistantCall, toolResult, assistantText];
const calls: ToolCall[] = [
  { id: 't1', tool_use_id: 'call_1', tool: 'read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 13, isError: false, pinned: false },
];

describe('toFcMessages', () => {
  it('maps tool results from the tool-role message and calls from parts', () => {
    const fc = toFcMessages(oc);
    expect(fc).toHaveLength(4);
    expect(fc[0]).toMatchObject({ role: 'user', text: 'read the config', toolUses: [] });
    expect(fc[1].role).toBe('assistant');
    expect(fc[1].toolUses).toEqual([{ tool_use_id: 'call_1', tool: 'read', input: { path: 'x.json' } }]);
    expect(fc[2].toolResults).toEqual([{ tool_use_id: 'call_1', text: 'file contents' }]);
    expect(fc[3].text).toBe('done');
  });
});

describe('applyOcDecisions', () => {
  const decision = (action: CallDecision['action']): CallDecision[] => [
    { id: 't1', tool: 'read', keepCall: 1, keepResult: 1, action, reason: 'kept' },
  ];

  it('returns untouched messages as the same objects', () => {
    const kept = applyOcDecisions(oc, [decision('keep')[0]], calls, 300);
    expect(kept).toEqual(oc);
    expect(kept[0]).toBe(oc[0]);
    expect(kept[3]).toBe(oc[3]);
  });

  it('drop_call removes the call and its whole result message', () => {
    const kept = applyOcDecisions(oc, decision('drop_call'), calls, 300);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(oc[0]);
    expect(kept[1]).toBe(oc[3]);
  });

  it('drop_result keeps the call and truncates the result value', () => {
    const long: OcMessage = {
      role: 'tool',
      content: [{ ...toolResult.content![0], result: { type: 'text', value: 'x'.repeat(1000) } }],
    };
    const kept = applyOcDecisions([assistantCall, long], decision('drop_result'), calls, 100);
    const part = kept[1].content?.[0];
    expect(part?.type).toBe('tool-result');
    expect(String((part?.result as { value: string }).value)).toContain('fast-compaction truncated');
    expect(kept[0]).toBe(assistantCall);
  });

  it('messageDecisions drop only the targeted assistant prose message', () => {
    const drops: MessageDecision[] = [{ i: 3, role: 'assistant', chars: 4, keep: false, reason: 'dropped' }];
    const kept = applyOcDecisions(oc, [], calls, 300, drops);
    expect(kept.map((m) => m.id ?? m.role)).toEqual(['msg_u1', 'msg_a1', 'tool']);
  });

  it('a prose-dropped assistant keeps its kept calls but loses text', () => {
    const drops: MessageDecision[] = [{ i: 1, role: 'assistant', chars: 0, keep: false, reason: 'dropped' }];
    const kept = applyOcDecisions(oc, [decision('keep')[0]], calls, 300, drops);
    expect(kept[1].content?.map((part) => part.type)).toEqual(['tool-call']);
  });
});

describe('restoreMessages', () => {
  it('prepends stored, drops marker summaries and id duplicates', () => {
    const marker: OcMessage = { role: 'user', content: [{ type: 'text', text: '[fast-compaction] compacted' }] };
    const incoming = [marker, userMsg, { ...assistantText }];
    const restored = restoreMessages([toolResult], incoming);
    expect(restored).toHaveLength(3);
    expect(restored[0]).toBe(toolResult);
    expect(restored).not.toContain(marker);
  });

  it('flags marker summaries', () => {
    expect(isMarkerSummary({ role: 'user', content: [{ type: 'text', text: '[fast-compaction] x' }] })).toBe(true);
    expect(isMarkerSummary(userMsg)).toBe(false);
  });

  it('derives mediaType from the filename extension when the data is not sniffable', () => {
    const stored: OcMessage[] = [
      {
        id: 'msg_m1',
        role: 'user',
        content: [
          { type: 'media', filename: 'shot.png', media: { source: { type: 'base64', data: 'AAAAAAAAAAAAAAAA' } } },
        ],
      },
    ];
    const restored = restoreMessages(stored, [userMsg]);
    const part = (restored[0]!.content as Array<{ type: string; media?: { mediaType?: string } }>)[0]!;
    expect(part.media?.mediaType).toBe('image/png');
  });

  it('sniffs mediaType from base64 magic when no filename extension helps', () => {
    const stored: OcMessage[] = [
      {
        id: 'msg_m1b',
        role: 'user',
        content: [{ type: 'media', media: { source: { type: 'base64', data: '/9j/4AAQSkZJRgABAQ' } } }],
      },
    ];
    const restored = restoreMessages(stored, []);
    const part = (restored[0]!.content as Array<{ type: string; media?: { mediaType?: string } }>)[0]!;
    expect(part.media?.mediaType).toBe('image/jpeg');
  });

  it('keeps an existing mediaType and falls back to a text part when none can be derived', () => {
    const typed: OcMessage = {
      id: 'msg_m2',
      role: 'user',
      content: [
        { type: 'media', media: { mediaType: 'image/webp', source: { type: 'base64', data: 'UklGRhoAAABXRUJQVlA4' } } },
      ],
    };
    const unknown: OcMessage = {
      id: 'msg_m3',
      role: 'user',
      content: [{ type: 'media', media: { source: { type: 'base64', data: 'not-a-signature' } } }],
    };
    const restored = restoreMessages([typed, unknown], []);
    const parts = restored.flatMap((message) => message.content as Array<{ type: string; media?: { mediaType?: string }; text?: string }>);
    expect(parts[0]!.media?.mediaType).toBe('image/webp');
    expect(parts[1]!.type).toBe('text');
    expect(parts[1]!.text).toContain('unsupported media part');
  });

  it('replaces media parts whose payload is a file path with a text part', () => {
    const windows: OcMessage = {
      id: 'msg_m4',
      role: 'user',
      content: [
        { type: 'media', media: { mediaType: 'image/png', source: { type: 'base64', data: 'C:\\Users\\x\\shot.png' } } },
      ],
    };
    const posix: OcMessage = {
      id: 'msg_m5',
      role: 'user',
      content: [
        { type: 'media', media: { mediaType: 'image/png', source: { type: 'base64', data: '/home/x/shot.png' } } },
      ],
    };
    const driftedType: OcMessage = {
      id: 'msg_m9',
      role: 'user',
      content: [
        { type: 'media', media: { mediaType: 'image/png', source: { type: 'text', data: 'AAAAAAAAAAAAAAAA' } } },
      ],
    };
    const restored = restoreMessages([windows, posix, driftedType], []);
    const parts = restored.flatMap((message) => message.content as Array<{ type: string; text?: string }>);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.type === 'text' && p.text!.includes('unsupported media part'))).toBe(true);
  });

  it('keeps url-form media payloads (data URL and https)', () => {
    const dataUrl: OcMessage = {
      id: 'msg_m6',
      role: 'user',
      content: [{ type: 'media', media: { mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANS' } }],
    };
    const http: OcMessage = {
      id: 'msg_m7',
      role: 'user',
      content: [{ type: 'media', media: { mediaType: 'image/png', url: 'https://example.com/shot.png' } }],
    };
    const inData: OcMessage = {
      id: 'msg_m8',
      role: 'user',
      content: [
        { type: 'media', media: { mediaType: 'image/png', source: { type: 'base64', data: 'data:image/png;base64,iVBORw0KGgo' } } },
      ],
    };
    const restored = restoreMessages([dataUrl, http, inData], []);
    const parts = restored.flatMap((message) => message.content as Array<{ type: string; media?: { mediaType?: string } }>);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.type === 'media' && p.media?.mediaType === 'image/png')).toBe(true);
  });
});

describe('truncatedResultText', () => {
  it('short results pass through unchanged', () => {
    expect(truncatedResultText('short', false, 100)).toBe('short');
  });
  it('long results get head plus note', () => {
    const out = truncatedResultText('y'.repeat(500), false, 100);
    expect(out.startsWith('y'.repeat(100))).toBe(true);
    expect(out).toContain('400 chars');
  });
});
