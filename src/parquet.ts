import parquet from 'parquetjs-lite';
import type { Qwen35Record } from './schemas/qwen35.js';

export function parquetSchema(): any {
  return new (parquet as any).ParquetSchema({
    id: { type: 'UTF8' },
    request_id: { type: 'UTF8', optional: true },
    endpoint: { type: 'UTF8' },
    status: { type: 'INT64' },
    ts: { type: 'UTF8' },
    key: { type: 'UTF8', optional: true },
    source: { type: 'UTF8', optional: true },
    requested_model: { type: 'UTF8', optional: true },
    actual_model: { type: 'UTF8', optional: true },
    stream: { type: 'BOOLEAN', optional: true },
    thinking_level: { type: 'UTF8', optional: true },
    reasoning_summary_mode_json: { type: 'UTF8', optional: true },
    thinking_type: { type: 'UTF8', optional: true },
    thinking_budget_tokens: { type: 'INT64', optional: true },
    max_output_tokens: { type: 'INT64', optional: true },
    tool_spec_count: { type: 'INT64', optional: true },
    tool_choice_json: { type: 'UTF8', optional: true },
    request_contains_non_text_content: { type: 'BOOLEAN' },
    request_image_block_count: { type: 'INT64' },
    request_video_block_count: { type: 'INT64' },
    request_tool_call_block_count: { type: 'INT64' },
    request_tool_result_block_count: { type: 'INT64' },
    request_thinking_block_count: { type: 'INT64' },
    response_contains_non_text_content: { type: 'BOOLEAN' },
    response_image_block_count: { type: 'INT64' },
    response_video_block_count: { type: 'INT64' },
    response_tool_call_block_count: { type: 'INT64' },
    response_tool_result_block_count: { type: 'INT64' },
    response_thinking_block_count: { type: 'INT64' },
    request_truncated: { type: 'BOOLEAN' },
    response_truncated: { type: 'BOOLEAN' },
    lossy_source: { type: 'BOOLEAN' },
    lossy_reasons_json: { type: 'UTF8' },
    user_message_count: { type: 'INT64' },
    assistant_message_count: { type: 'INT64' },
    tool_message_count: { type: 'INT64' },
    dialogue_rounds_est: { type: 'INT64' },
    tool_call_count: { type: 'INT64' },
    has_reasoning: { type: 'BOOLEAN' },
    reasoning_chars: { type: 'INT64' },
    content_chars_total: { type: 'INT64' },
    messages_json: { type: 'UTF8' },
    tools_json: { type: 'UTF8' },
    meta_json: { type: 'UTF8' },
  });
}

export function recordToParquetRow(record: Qwen35Record): Record<string, unknown> {
  const messages = record.messages;
  const userMessageCount = messages.filter((m) => m.role === 'user').length;
  const assistantMessages = messages.filter((m): m is Extract<Qwen35Record['messages'][number], { role: 'assistant' }> => m.role === 'assistant');
  const toolMessageCount = messages.filter((m) => m.role === 'tool').length;
  const toolCallCount = assistantMessages.reduce((sum, message) => sum + (message.tool_calls?.length ?? 0), 0);
  const reasoningChars = assistantMessages.reduce((sum, message) => sum + (typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0), 0);
  const contentCharsTotal = messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
  return {
    id: record.id,
    request_id: record.request_id,
    endpoint: record.meta.endpoint,
    status: record.meta.status,
    ts: record.meta.ts,
    key: record.meta.key,
    source: record.meta.source,
    requested_model: record.meta.requested_model ?? undefined,
    actual_model: record.meta.actual_model ?? undefined,
    stream: record.meta.stream,
    thinking_level: record.meta.thinking_level ?? undefined,
    reasoning_summary_mode_json: JSON.stringify(record.meta.reasoning_summary_mode ?? null),
    thinking_type: record.meta.thinking_type ?? undefined,
    thinking_budget_tokens: record.meta.thinking_budget_tokens ?? undefined,
    max_output_tokens: record.meta.max_output_tokens ?? undefined,
    tool_spec_count: record.meta.tool_spec_count,
    tool_choice_json: JSON.stringify(record.meta.tool_choice ?? null),
    request_contains_non_text_content: record.meta.request_contains_non_text_content,
    request_image_block_count: record.meta.request_image_block_count,
    request_video_block_count: record.meta.request_video_block_count,
    request_tool_call_block_count: record.meta.request_tool_call_block_count,
    request_tool_result_block_count: record.meta.request_tool_result_block_count,
    request_thinking_block_count: record.meta.request_thinking_block_count,
    response_contains_non_text_content: record.meta.response_contains_non_text_content,
    response_image_block_count: record.meta.response_image_block_count,
    response_video_block_count: record.meta.response_video_block_count,
    response_tool_call_block_count: record.meta.response_tool_call_block_count,
    response_tool_result_block_count: record.meta.response_tool_result_block_count,
    response_thinking_block_count: record.meta.response_thinking_block_count,
    request_truncated: record.meta.request_truncated,
    response_truncated: record.meta.response_truncated,
    lossy_source: record.meta.lossy_source,
    lossy_reasons_json: JSON.stringify(record.meta.lossy_reasons),
    user_message_count: userMessageCount,
    assistant_message_count: assistantMessages.length,
    tool_message_count: toolMessageCount,
    dialogue_rounds_est: userMessageCount,
    tool_call_count: toolCallCount,
    has_reasoning: reasoningChars > 0,
    reasoning_chars: reasoningChars,
    content_chars_total: contentCharsTotal,
    messages_json: JSON.stringify(record.messages),
    tools_json: JSON.stringify(record.tools),
    meta_json: JSON.stringify(record.meta),
  };
}

export async function writeParquet(filePath: string, records: Qwen35Record[]): Promise<void> {
  const writer = await (parquet as any).ParquetWriter.openFile(parquetSchema(), filePath);
  try {
    for (const record of records) {
      await writer.appendRow(recordToParquetRow(record));
    }
  } finally {
    await writer.close();
  }
}
