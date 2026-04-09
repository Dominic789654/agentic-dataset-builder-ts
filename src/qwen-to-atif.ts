import { ROUNDTRIP_VERSION } from './roundtrip.js';
import { AtifTrajectorySchema, type AtifStep, type AtifToolCall, type AtifTrajectory } from './schemas/atif.js';
import { Qwen35RecordSchema, type Qwen35Record } from './schemas/qwen35.js';
import { parseCanonicalJson, toCanonicalJson } from './utils/canonical-json.js';

export function qwen35RecordToAtifTrajectory(input: Qwen35Record): AtifTrajectory {
  const record = normalizeQwen35Record(input);
  const exactTrajectoryJson = record.meta.roundtrip?.atif_trajectory_json;
  if (exactTrajectoryJson) {
    return normalizeAtifTrajectory(parseCanonicalJson<AtifTrajectory>(exactTrajectoryJson));
  }

  const steps: AtifTrajectory['steps'] = [];
  const actualModel = record.meta.actual_model ?? record.meta.requested_model ?? undefined;

  for (let index = 0; index < record.messages.length; index += 1) {
    const message = record.messages[index];

    if (message.role === 'system') {
      steps.push({
        step_id: steps.length + 1,
        source: 'system',
        message: renderQwenContentAsText(message.content),
      });
      continue;
    }

    if (message.role === 'user') {
      steps.push({
        step_id: steps.length + 1,
        source: 'user',
        message: renderQwenContentAsText(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = buildToolCalls(message, steps.length + 1);
      const observationResults: NonNullable<AtifStep['observation']>['results'] = [];
      let cursor = index + 1;
      while (cursor < record.messages.length && record.messages[cursor]?.role === 'tool') {
        const toolMessage = record.messages[cursor] as Extract<Qwen35Record['messages'][number], { role: 'tool' }>;
        const sourceCallId = ensureToolCall(toolCalls, toolMessage, steps.length + 1, observationResults.length + 1);
        observationResults.push({
          source_call_id: sourceCallId,
          content: renderQwenContentAsText(toolMessage.content),
        });
        cursor += 1;
      }

      steps.push({
        step_id: steps.length + 1,
        source: 'agent',
        message: renderQwenContentAsText(message.content),
        reasoning_content: message.reasoning_content,
        model_name: actualModel,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        observation: observationResults.length ? { results: observationResults } : undefined,
      });
      index = cursor - 1;
      continue;
    }

    const toolCalls: AtifToolCall[] = [];
    const observationResults: NonNullable<AtifStep['observation']>['results'] = [];
    let cursor = index;
    while (cursor < record.messages.length && record.messages[cursor]?.role === 'tool') {
      const toolMessage = record.messages[cursor] as Extract<Qwen35Record['messages'][number], { role: 'tool' }>;
      const sourceCallId = ensureToolCall(toolCalls, toolMessage, steps.length + 1, observationResults.length + 1);
      observationResults.push({
        source_call_id: sourceCallId,
        content: renderQwenContentAsText(toolMessage.content),
      });
      cursor += 1;
    }

    steps.push({
      step_id: steps.length + 1,
      source: 'agent',
      message: '',
      model_name: actualModel,
      tool_calls: toolCalls,
      observation: { results: observationResults },
    });
    index = cursor - 1;
  }

  return normalizeAtifTrajectory({
    schema_version: 'ATIF-v1.4',
    session_id: record.request_id ?? record.id,
    agent: {
      name: deriveAgentName(record),
      model_name: actualModel,
    },
    steps,
    final_metrics: {
      total_steps: steps.length,
    },
    extra: {
      roundtrip: {
        version: ROUNDTRIP_VERSION,
        qwen35_record_json: JSON.stringify(record),
      },
    },
  });
}

function buildToolCalls(
  message: Extract<Qwen35Record['messages'][number], { role: 'assistant' }>,
  stepId: number,
): AtifToolCall[] {
  return (message.tool_calls ?? []).map((toolCall, index) => ({
    tool_call_id: toolCall.id ?? syntheticToolCallId(stepId, index + 1),
    function_name: toolCall.function.name,
    arguments: normalizeJsonObject(toolCall.function.arguments),
  }));
}

function ensureToolCall(
  toolCalls: AtifToolCall[],
  toolMessage: Extract<Qwen35Record['messages'][number], { role: 'tool' }>,
  stepId: number,
  ordinal: number,
): string {
  const existingId = toolMessage.tool_call_id;
  if (existingId) {
    if (!toolCalls.some((toolCall) => toolCall.tool_call_id === existingId)) {
      toolCalls.push({
        tool_call_id: existingId,
        function_name: toolMessage.name ?? syntheticToolName(stepId, ordinal),
        arguments: {},
        extra: { synthesized_from_tool_message: true },
      });
    }
    return existingId;
  }

  const syntheticId = syntheticToolCallId(stepId, toolCalls.length + 1);
  toolCalls.push({
    tool_call_id: syntheticId,
    function_name: toolMessage.name ?? syntheticToolName(stepId, ordinal),
    arguments: {},
    extra: { synthesized_from_tool_message: true },
  });
  return syntheticId;
}

function renderQwenContentAsText(content: Qwen35Record['messages'][number]['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      if (block.type === 'image') {
        return block.placeholder_token ?? '<|vision_start|><|image_pad|><|vision_end|>';
      }
      return block.placeholder_token ?? '<|vision_start|><|video_pad|><|vision_end|>';
    })
    .join('');
}

function deriveAgentName(record: Qwen35Record): string {
  if (record.source_system) {
    return record.source_system;
  }
  const normalized = record.meta.endpoint.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'qwen35-record';
}

function syntheticToolCallId(stepId: number, ordinal: number): string {
  return `tool_call_${stepId}_${ordinal}`;
}

function syntheticToolName(stepId: number, ordinal: number): string {
  return `tool_${stepId}_${ordinal}`;
}

function normalizeJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return parseCanonicalJson<Record<string, unknown>>(toCanonicalJson(value));
}

function normalizeAtifTrajectory(input: AtifTrajectory): AtifTrajectory {
  const parsed = AtifTrajectorySchema.parse(input);
  return AtifTrajectorySchema.parse(parseCanonicalJson<AtifTrajectory>(toCanonicalJson(parsed)));
}

function normalizeQwen35Record(input: Qwen35Record): Qwen35Record {
  return Qwen35RecordSchema.parse(input);
}
