import { describe, expect, it } from 'vitest';
import { labelRecord } from './labeling.js';
import { Qwen35RecordSchema } from './schemas/qwen35.js';

describe('labelRecord', () => {
  it('marks visible reasoning agent traces as cot_eligible', () => {
    const record = Qwen35RecordSchema.parse({
      id: 'x',
      request_id: 'x',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'reason',
          tool_calls: [{ type: 'function', function: { name: 'bash', arguments: {} } }],
        },
        { role: 'tool', name: 'bash', content: 'ok' },
      ],
      tools: [{ name: 'bash' }],
      meta: {
        endpoint: 'x',
        status: 200,
        ts: '2026-01-01T00:00:00Z',
        request_contains_non_text_content: false,
        request_image_block_count: 0,
        request_video_block_count: 0,
        request_tool_call_block_count: 0,
        request_tool_result_block_count: 0,
        request_thinking_block_count: 0,
        response_contains_non_text_content: false,
        response_image_block_count: 0,
        response_video_block_count: 0,
        response_tool_call_block_count: 1,
        response_tool_result_block_count: 1,
        response_thinking_block_count: 1,
        request_truncated: false,
        response_truncated: false,
        lossy_source: false,
        lossy_reasons: [],
      },
    });
    expect(labelRecord(record).label).toBe('cot_eligible');
  });

  it('marks prompt-history records as prompt_only', () => {
    const record = Qwen35RecordSchema.parse({
      id: 'y',
      request_id: 'y',
      messages: [{ role: 'user', content: 'prompt' }],
      tools: [],
      meta: {
        endpoint: 'claude/prompt_history',
        status: 200,
        ts: '2026-01-01T00:00:00Z',
        request_contains_non_text_content: false,
        request_image_block_count: 0,
        request_video_block_count: 0,
        request_tool_call_block_count: 0,
        request_tool_result_block_count: 0,
        request_thinking_block_count: 0,
        response_contains_non_text_content: false,
        response_image_block_count: 0,
        response_video_block_count: 0,
        response_tool_call_block_count: 0,
        response_tool_result_block_count: 0,
        response_thinking_block_count: 0,
        request_truncated: false,
        response_truncated: false,
        lossy_source: true,
        lossy_reasons: ['prompt_history_only', 'assistant_trace_unavailable'],
      },
    });
    expect(labelRecord(record).label).toBe('prompt_only');
  });
});
