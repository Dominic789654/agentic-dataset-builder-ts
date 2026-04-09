import { AtifTrajectorySchema, type AtifTrajectory } from './schemas/atif.js';
import { Qwen35RecordSchema, type Qwen35Record } from './schemas/qwen35.js';
import { parseCanonicalJson, toCanonicalJson } from './utils/canonical-json.js';

export function buildAtifFixture(): AtifTrajectory {
  return {
    schema_version: 'ATIF-v1.4',
    session_id: 'atif-session-1',
    agent: {
      name: 'claude-code',
      version: '1.0.0',
      model_name: 'claude-3-5-sonnet-20241022',
    },
    steps: [
      {
        step_id: 1,
        timestamp: '2025-01-15T10:00:00Z',
        source: 'system',
        message: 'You are a coding agent.',
      },
      {
        step_id: 2,
        timestamp: '2025-01-15T10:00:01Z',
        source: 'user',
        message: 'Inspect the repo and delegate if needed.',
      },
      {
        step_id: 3,
        timestamp: '2025-01-15T10:00:02Z',
        source: 'agent',
        message: 'I will inspect and delegate.',
        reasoning_content: '<think>\nNeed to compare files.\n</think>',
        model_name: 'claude-3-5-sonnet-20241022',
        tool_calls: [
          {
            tool_call_id: 'call_ls',
            function_name: 'bash',
            arguments: {
              cmd: 'ls',
              flags: ['-la'],
            },
            extra: {
              cwd: '/repo',
            },
          },
          {
            tool_call_id: 'call_delegate',
            function_name: 'Task',
            arguments: {
              description: 'Inspect subdir',
              priority: 'high',
            },
          },
        ],
        observation: {
          results: [
            {
              source_call_id: 'call_ls',
              content: 'total 8',
              extra: {
                exit_code: 0,
              },
            },
            {
              source_call_id: 'call_delegate',
              content: null,
              subagent_trajectory_ref: 'subagent-1',
              extra: {
                delegated: true,
              },
            },
          ],
          extra: {
            kind: 'parallel',
          },
        },
        metrics: {
          prompt_tokens: 32,
          completion_tokens: 18,
          cached_tokens: 4,
          cost_usd: 0.01,
          extra: {
            latency_ms: 120,
          },
        },
      },
      {
        step_id: 4,
        timestamp: '2025-01-15T10:00:03Z',
        source: 'user',
        message: 'Thanks',
      },
    ],
    final_metrics: {
      total_prompt_tokens: 32,
      total_completion_tokens: 18,
      total_cached_tokens: 4,
      total_cost_usd: 0.01,
      total_steps: 4,
      extra: {
        wall_time_ms: 200,
      },
    },
    extra: {
      project: 'demo',
      tags: ['roundtrip', 'atif'],
    },
  };
}

export function canonicalAtifFixture(): AtifTrajectory {
  const parsed = AtifTrajectorySchema.parse(buildAtifFixture());
  return AtifTrajectorySchema.parse(parseCanonicalJson<AtifTrajectory>(toCanonicalJson(parsed)));
}

export function buildAtifStressFixture(): AtifTrajectory {
  return {
    schema_version: 'ATIF-v1.4',
    session_id: 'atif-stress-1',
    agent: {
      name: 'codex',
      version: '2.0.0',
      model_name: 'gpt-5-codex',
      extra: {
        mode: 'stress',
      },
    },
    steps: [
      {
        step_id: 1,
        timestamp: '2025-02-01T08:00:00Z',
        source: 'system',
        message: 'Be exact and terse.',
      },
      {
        step_id: 2,
        timestamp: '2025-02-01T08:00:01Z',
        source: 'user',
        message: 'Run several checks and summarize.',
      },
      {
        step_id: 3,
        timestamp: '2025-02-01T08:00:02Z',
        source: 'agent',
        message: '',
        reasoning_content: '<think>\nNeed to fan out.\n</think>',
        model_name: 'gpt-5-codex',
        tool_calls: [
          {
            tool_call_id: 'stress_call_1',
            function_name: 'bash',
            arguments: {
              command: 'npm test',
              timeout: 120,
            },
          },
          {
            tool_call_id: 'stress_call_2',
            function_name: 'read',
            arguments: {
              path: 'README.md',
              offset: 1,
              limit: 40,
            },
          },
          {
            tool_call_id: 'stress_call_3',
            function_name: 'Task',
            arguments: {
              description: 'Inspect generated files',
              priority: 'high',
            },
          },
        ],
        observation: {
          results: [
            {
              source_call_id: 'stress_call_1',
              content: 'tests passed',
            },
            {
              source_call_id: 'stress_call_2',
              content: 'README excerpt',
            },
            {
              source_call_id: 'stress_call_3',
              content: null,
              subagent_trajectory_ref: 'subagent-stress-1',
            },
          ],
        },
        metrics: {
          prompt_tokens: 91,
          completion_tokens: 27,
          cached_tokens: 8,
          cost_usd: 0.02,
          extra: {
            latency_ms: 240,
          },
        },
      },
      {
        step_id: 4,
        timestamp: '2025-02-01T08:00:04Z',
        source: 'user',
        message: 'Continue with a short answer.',
      },
      {
        step_id: 5,
        timestamp: '2025-02-01T08:00:05Z',
        source: 'agent',
        message: 'All checks are green.',
        reasoning_content: 'Summarize only.',
        model_name: 'gpt-5-codex',
      },
    ],
    final_metrics: {
      total_prompt_tokens: 91,
      total_completion_tokens: 27,
      total_cached_tokens: 8,
      total_cost_usd: 0.02,
      total_steps: 5,
    },
    extra: {
      suite: 'stress',
      labels: ['multi-tool', 'empty-agent-message'],
    },
  };
}

export function canonicalAtifStressFixture(): AtifTrajectory {
  const parsed = AtifTrajectorySchema.parse(buildAtifStressFixture());
  return AtifTrajectorySchema.parse(parseCanonicalJson<AtifTrajectory>(toCanonicalJson(parsed)));
}

export function buildQwenFixture(): Qwen35Record {
  return {
    id: 'qwen-record-1',
    request_id: 'qwen-record-1',
    messages: [
      {
        role: 'system',
        content: 'You are a coding agent.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect ' },
          {
            type: 'image',
            image_url: 'file:///tmp/demo.png',
            placeholder_token: '<image-1>',
            metadata: { size: '1024x768' },
          },
          { type: 'text', text: ' and summarize.' },
        ],
      },
      {
        role: 'assistant',
        content: 'I will inspect it.',
        reasoning_content: 'Compare the visible structure.',
        tool_calls: [
          {
            type: 'function',
            function: {
              name: 'bash',
              arguments: {
                cmd: 'ls',
                flags: ['-la'],
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        name: 'bash',
        content: [
          { type: 'text', text: 'done ' },
          {
            type: 'video',
            video_url: 'file:///tmp/demo.mp4',
            placeholder_token: '<video-1>',
            metadata: { seconds: 3 },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Finished.',
        reasoning_content: 'All set.',
      },
    ],
    tools: [
      {
        name: 'bash',
        description: 'Run shell commands',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string' },
            flags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    ],
    meta: {
      endpoint: 'openai/chat/completions',
      status: 200,
      ts: '2026-01-01T00:00:00Z',
      key: 'qwen-record-1',
      source: 'fixture:qwen',
      requested_model: 'Qwen/Qwen3.5-9B',
      actual_model: 'Qwen/Qwen3.5-9B',
      stream: false,
      reasoning_summary_mode: 'full',
      thinking_type: 'inline',
      tool_spec_count: 1,
      tool_choice: 'auto',
      request_contains_non_text_content: true,
      request_image_block_count: 1,
      request_video_block_count: 0,
      request_tool_call_block_count: 0,
      request_tool_result_block_count: 0,
      request_thinking_block_count: 0,
      response_contains_non_text_content: true,
      response_image_block_count: 0,
      response_video_block_count: 1,
      response_tool_call_block_count: 1,
      response_tool_result_block_count: 1,
      response_thinking_block_count: 2,
      request_truncated: false,
      response_truncated: false,
      lossy_source: false,
      lossy_reasons: [],
    },
  };
}

export function canonicalQwenFixture(): Qwen35Record {
  const parsed = Qwen35RecordSchema.parse(buildQwenFixture());
  return Qwen35RecordSchema.parse(parseCanonicalJson<Qwen35Record>(toCanonicalJson(parsed)));
}

export function buildQwenStressFixture(): Qwen35Record {
  return {
    id: 'qwen-stress-1',
    request_id: 'qwen-stress-1',
    messages: [
      {
        role: 'system',
        content: 'You are exact and format-preserving.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect ' },
          { type: 'image', image_url: 'file:///tmp/a.png', placeholder_token: '<img-a>', metadata: { slot: 'a' } },
          { type: 'text', text: ' then ' },
          { type: 'image', image_url: 'file:///tmp/b.png', placeholder_token: '<img-b>', metadata: { slot: 'b' } },
          { type: 'text', text: ' and review ' },
          { type: 'video', video_url: 'file:///tmp/a.mp4', placeholder_token: '<vid-a>', metadata: { slot: 'v1' } },
          { type: 'text', text: '.' },
        ],
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need two tools.',
        tool_calls: [
          {
            type: 'function',
            id: 'call_a',
            function: {
              name: 'read_file',
              arguments: {
                path: 'README.md',
                lines: [1, 2, 3],
                options: {
                  encoding: 'utf8',
                  trim: true,
                },
              },
            },
          },
          {
            type: 'function',
            id: 'call_b',
            function: {
              name: 'list_dir',
              arguments: {
                path: 'src',
                includeHidden: false,
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        name: 'read_file',
        tool_call_id: 'call_a',
        content: [
          { type: 'text', text: 'file ' },
          { type: 'image', image_url: 'file:///tmp/c.png', placeholder_token: '<img-c>', metadata: { slot: 'c' } },
          { type: 'text', text: ' loaded' },
        ],
      },
      {
        role: 'tool',
        name: 'list_dir',
        tool_call_id: 'call_b',
        content: [
          { type: 'text', text: 'video ' },
          { type: 'video', video_url: 'file:///tmp/b.mp4', placeholder_token: '<vid-b>', metadata: { slot: 'v2' } },
          { type: 'text', text: ' listed' },
        ],
      },
      {
        role: 'user',
        content: 'Continue with the final answer.',
      },
      {
        role: 'assistant',
        content: '<think>\nInternal follow-up.\n</think>\nVisible summary.',
      },
    ],
    tools: [
      {
        name: 'read_file',
        description: 'Read one file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            lines: { type: 'array', items: { type: 'integer' } },
            options: {
              type: 'object',
              properties: {
                encoding: { type: 'string' },
                trim: { type: 'boolean' },
              },
            },
          },
        },
      },
      {
        name: 'list_dir',
        description: 'List directory entries',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            includeHidden: { type: 'boolean' },
          },
        },
      },
    ],
    meta: {
      endpoint: 'openai/chat/completions',
      status: 200,
      ts: '2026-02-01T00:00:00Z',
      key: 'qwen-stress-1',
      source: 'fixture:qwen-stress',
      requested_model: 'Qwen/Qwen3.5-9B',
      actual_model: 'Qwen/Qwen3.5-9B',
      stream: false,
      reasoning_summary_mode: 'full',
      thinking_type: 'inline',
      tool_spec_count: 2,
      tool_choice: 'auto',
      request_contains_non_text_content: true,
      request_image_block_count: 2,
      request_video_block_count: 1,
      request_tool_call_block_count: 0,
      request_tool_result_block_count: 0,
      request_thinking_block_count: 0,
      response_contains_non_text_content: true,
      response_image_block_count: 1,
      response_video_block_count: 1,
      response_tool_call_block_count: 2,
      response_tool_result_block_count: 2,
      response_thinking_block_count: 2,
      request_truncated: false,
      response_truncated: false,
      lossy_source: false,
      lossy_reasons: [],
    },
  };
}

export function canonicalQwenStressFixture(): Qwen35Record {
  const parsed = Qwen35RecordSchema.parse(buildQwenStressFixture());
  return Qwen35RecordSchema.parse(parseCanonicalJson<Qwen35Record>(toCanonicalJson(parsed)));
}
