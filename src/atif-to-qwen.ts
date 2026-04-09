import { ROUNDTRIP_VERSION } from './roundtrip.js';
import { AtifTrajectorySchema, type AtifStep, type AtifTrajectory } from './schemas/atif.js';
import { Qwen35RecordSchema, type Qwen35Record } from './schemas/qwen35.js';
import { parseCanonicalJson, toCanonicalJson } from './utils/canonical-json.js';

export function atifTrajectoryToQwen35Record(input: AtifTrajectory): Qwen35Record {
  const trajectory = normalizeAtifTrajectory(input);
  const restored = restoreQwen35RecordFromRoundtrip(trajectory);
  if (restored) {
    return restored;
  }

  const messages: Qwen35Record['messages'] = [];
  const tools = new Map<string, { name: string; description?: string; parameters?: Record<string, unknown> }>();
  let actualModel: string | undefined;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let thinkingCount = 0;

  for (const step of trajectory.steps) {
    const role = mapStepRole(step);
    const content = normalizeStepMessage(step.message);

    if (role === 'system') {
      messages.push({ role: 'system', content });
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content });
      continue;
    }

    actualModel ??= step.model_name ?? trajectory.agent.model_name ?? undefined;

    const assistant: Extract<Qwen35Record['messages'][number], { role: 'assistant' }> = {
      role: 'assistant',
      content,
    };

    if (step.reasoning_content) {
      assistant.reasoning_content = sanitizeThinking(step.reasoning_content);
      if (assistant.reasoning_content) {
        thinkingCount += 1;
      }
    }

    if (step.tool_calls?.length) {
      assistant.tool_calls = step.tool_calls.map((toolCall) => {
        toolCallCount += 1;
        if (!tools.has(toolCall.function_name)) {
          tools.set(toolCall.function_name, {
            name: toolCall.function_name,
            parameters: toolCall.arguments,
          });
        }
        return {
          type: 'function',
          id: toolCall.tool_call_id,
          function: {
            name: toolCall.function_name,
            arguments: toolCall.arguments,
          },
        };
      });
    }

    messages.push(assistant);

    for (const observationResult of step.observation?.results ?? []) {
      toolResultCount += 1;
      messages.push(formatObservationResult(observationResult, step.tool_calls ?? []));
    }
  }

  return normalizeQwen35Record({
    id: trajectory.session_id,
    request_id: trajectory.session_id,
    messages,
    tools: [...tools.values()],
    meta: {
      endpoint: `atif/${normalizeAgentName(trajectory.agent.name)}`,
      status: 200,
      ts: trajectory.steps.at(-1)?.timestamp ?? trajectory.steps[0]?.timestamp ?? '',
      key: trajectory.session_id,
      source: `atif:session=${trajectory.session_id}`,
      requested_model: trajectory.agent.model_name ?? undefined,
      actual_model: actualModel,
      stream: false,
      thinking_level: undefined,
      reasoning_summary_mode: 'atif_roundtrip',
      thinking_type: 'atif_trajectory',
      thinking_budget_tokens: undefined,
      max_output_tokens: undefined,
      tool_spec_count: tools.size,
      tool_choice: { mode: 'trajectory_projection' },
      request_contains_non_text_content: false,
      request_image_block_count: 0,
      request_video_block_count: 0,
      request_tool_call_block_count: 0,
      request_tool_result_block_count: 0,
      request_thinking_block_count: 0,
      response_contains_non_text_content: false,
      response_image_block_count: 0,
      response_video_block_count: 0,
      response_tool_call_block_count: toolCallCount,
      response_tool_result_block_count: toolResultCount,
      response_thinking_block_count: thinkingCount,
      request_truncated: false,
      response_truncated: false,
      lossy_source: false,
      lossy_reasons: [],
      roundtrip: {
        version: ROUNDTRIP_VERSION,
        canonical_source: 'atif',
        atif_trajectory_json: toCanonicalJson(trajectory),
      },
    },
  });
}

function restoreQwen35RecordFromRoundtrip(trajectory: AtifTrajectory): Qwen35Record | null {
  const exactRecordJson = getNestedString(trajectory.extra, ['roundtrip', 'qwen35_record_json']);
  if (!exactRecordJson) {
    return null;
  }
  return normalizeQwen35Record(parseCanonicalJson<Qwen35Record>(exactRecordJson));
}

function mapStepRole(step: AtifStep): 'system' | 'user' | 'assistant' {
  if (step.source === 'system') return 'system';
  if (step.source === 'user') return 'user';
  return 'assistant';
}

function normalizeStepMessage(message: string | undefined): Qwen35Record['messages'][number]['content'] {
  return message ?? '';
}

function formatObservationResult(
  result: NonNullable<NonNullable<AtifStep['observation']>['results']>[number],
  toolCalls: NonNullable<AtifStep['tool_calls']>,
): Extract<Qwen35Record['messages'][number], { role: 'tool' }> {
  const toolName = toolCalls.find((toolCall) => toolCall.tool_call_id === result.source_call_id)?.function_name;
  let content: Qwen35Record['messages'][number]['content'];
  if (result.content !== undefined && result.content !== null) {
    content = result.content;
  } else if (result.subagent_trajectory_ref) {
    content = `[subagent_trajectory_ref]\n${result.subagent_trajectory_ref}`;
  } else {
    content = '';
  }
  return {
    role: 'tool',
    tool_call_id: result.source_call_id,
    name: toolName,
    content,
  };
}

function sanitizeThinking(value: string): string {
  return value.replace(/<\/?think>/gi, '').trim();
}

function normalizeAgentName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'unknown-agent';
}

function normalizeAtifTrajectory(input: AtifTrajectory): AtifTrajectory {
  const parsed = AtifTrajectorySchema.parse(input);
  return AtifTrajectorySchema.parse(parseCanonicalJson<AtifTrajectory>(toCanonicalJson(parsed)));
}

function normalizeQwen35Record(input: Qwen35Record): Qwen35Record {
  return Qwen35RecordSchema.parse(input);
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}
