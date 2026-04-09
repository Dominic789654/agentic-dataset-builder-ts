import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Qwen35RecordSchema } from './qwen35.js';

const qwen35SchemaJson = JSON.parse(
  fs.readFileSync(path.resolve('schemas/qwen35.schema.json'), 'utf8'),
) as Record<string, any>;

describe('Qwen35RecordSchema', () => {
  it('accepts a minimal valid record', () => {
    const record = Qwen35RecordSchema.parse({
      id: 'r1',
      request_id: 'req1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      meta: {
        endpoint: 'test',
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
        lossy_source: false,
        lossy_reasons: [],
      },
    });
    expect(record.id).toBe('r1');
  });

  it('preserves explicit round-trip metadata', () => {
    const record = Qwen35RecordSchema.parse({
      id: 'r3',
      request_id: 'req3',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      meta: {
        endpoint: 'test',
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
        lossy_source: false,
        lossy_reasons: [],
        roundtrip: {
          version: 'agentic-dataset-builder/roundtrip-v1',
          canonical_source: 'atif',
          atif_trajectory_json: '{"session_id":"s1"}',
        },
      },
    });

    expect(record.meta.roundtrip?.canonical_source).toBe('atif');
  });

  it('rejects records without any user message', () => {
    expect(() =>
      Qwen35RecordSchema.parse({
        id: 'r2',
        messages: [{ role: 'assistant', content: 'hi' }],
        tools: [],
        meta: {
          endpoint: 'test',
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
          lossy_source: false,
          lossy_reasons: [],
        },
      }),
    ).toThrow();
  });

  it('ships a JSON schema with the expected top-level fields', () => {
    expect(qwen35SchemaJson.title).toBe('Qwen35 Record');
    expect(qwen35SchemaJson.type).toBe('object');
    expect(qwen35SchemaJson.required).toEqual(['id', 'messages', 'tools', 'meta']);
    expect((qwen35SchemaJson.$defs as Record<string, unknown>).Message).toBeDefined();
    expect((qwen35SchemaJson.$defs as Record<string, unknown>).Meta).toBeDefined();
    expect((qwen35SchemaJson.$defs as Record<string, unknown>).Roundtrip).toBeDefined();
  });
});
