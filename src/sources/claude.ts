import fg from 'fast-glob';
import { Qwen35RecordSchema, type Qwen35Record } from '../schemas/qwen35.js';
import { ClaudeProjectEntrySchema } from '../schemas/source.js';
import { readJsonl } from '../utils/jsonl.js';

export async function collectClaudePromptOnlyRecords(root: string): Promise<Qwen35Record[]> {
  const files = await fg('**/*.jsonl', { cwd: root, absolute: true, onlyFiles: true });
  const records: Qwen35Record[] = [];
  for (const file of files.sort()) {
    const entries = (await readJsonl(file)).map((row) => ClaudeProjectEntrySchema.parse(row));
    for (const entry of entries) {
      if (entry.type !== 'user') continue;
      const message = isRecord(entry.message) ? entry.message : {};
      const content = asString(message.content);
      if (!content) continue;
      records.push(Qwen35RecordSchema.parse({
        id: `${asString(entry.sessionId) ?? file}:${asString(entry.promptId) ?? asString(entry.uuid) ?? 'prompt'}`,
        request_id: asString(entry.promptId) ?? asString(entry.uuid) ?? undefined,
        messages: [{ role: 'user', content }],
        tools: [],
        meta: {
          endpoint: 'claude/prompt_history',
          status: 200,
          ts: asString(entry.timestamp) ?? '',
          key: asString(entry.sessionId) ?? undefined,
          source: `claude:session=${asString(entry.sessionId)}:cwd=${asString(entry.cwd)}:entrypoint=${asString(entry.entrypoint)}`,
          requested_model: undefined,
          actual_model: undefined,
          stream: false,
          thinking_level: undefined,
          reasoning_summary_mode: 'claude_prompt_only',
          thinking_type: 'prompt_history_only',
          tool_spec_count: 0,
          tool_choice: { mode: 'prompt_only' },
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
      }));
    }
  }
  return records;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
