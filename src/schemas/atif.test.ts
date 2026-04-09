import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtifTrajectorySchema } from './atif.js';

const atifSchemaJson = JSON.parse(
  fs.readFileSync(path.resolve('schemas/atif.schema.json'), 'utf8'),
) as Record<string, any>;

describe('AtifTrajectorySchema', () => {
  it('accepts a minimal valid trajectory', () => {
    const trajectory = AtifTrajectorySchema.parse({
      schema_version: 'ATIF-v1.4',
      session_id: 'session-123',
      agent: {
        name: 'claude-code',
        version: '1.0.0',
        model_name: 'claude-3-5-sonnet-20241022',
      },
      steps: [
        {
          step_id: 1,
          timestamp: '2025-01-15T10:30:00Z',
          source: 'user',
          message: 'Create hello.txt',
        },
        {
          step_id: 2,
          timestamp: '2025-01-15T10:30:02Z',
          source: 'agent',
          message: 'I will create the file.',
          reasoning_content: 'The request is straightforward.',
          model_name: 'claude-3-5-sonnet-20241022',
          tool_calls: [
            {
              tool_call_id: 'call_1',
              function_name: 'file_write',
              arguments: { path: 'hello.txt', content: 'Hello, world!' },
            },
          ],
          observation: {
            results: [
              {
                source_call_id: 'call_1',
                content: 'File created successfully',
              },
            ],
          },
          metrics: {
            prompt_tokens: 520,
            completion_tokens: 80,
            cached_tokens: 200,
            cost_usd: 0.00045,
          },
        },
      ],
      final_metrics: {
        total_prompt_tokens: 520,
        total_completion_tokens: 80,
        total_cached_tokens: 200,
        total_cost_usd: 0.00045,
        total_steps: 2,
      },
    });

    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps[1]?.tool_calls?.[0]?.function_name).toBe('file_write');
  });

  it('rejects non-sequential step ids', () => {
    expect(() =>
      AtifTrajectorySchema.parse({
        schema_version: 'ATIF-v1.4',
        session_id: 'session-123',
        agent: { name: 'claude-code' },
        steps: [
          { step_id: 1, source: 'user', message: 'hi' },
          { step_id: 3, source: 'agent', message: 'hello' },
        ],
      }),
    ).toThrow();
  });

  it('ships a JSON schema with the expected top-level fields', () => {
    expect(atifSchemaJson.title).toBe('ATIF Trajectory');
    expect(atifSchemaJson.type).toBe('object');
    expect(atifSchemaJson.required).toEqual(['schema_version', 'session_id', 'agent', 'steps']);
    expect((atifSchemaJson.$defs as Record<string, unknown>).Step).toBeDefined();
    expect((atifSchemaJson.$defs as Record<string, unknown>).ToolCall).toBeDefined();
    expect((atifSchemaJson.$defs as Record<string, unknown>).FinalMetrics).toBeDefined();
  });
});
