import type { Qwen35Record } from './schemas/qwen35.js';

export type Label = 'cot_eligible' | 'agent_only' | 'prompt_only' | 'discard';

export interface LabelInfo {
  label: Label;
  toolCallCount: number;
  toolMessageCount: number;
  dialogueRounds: number;
  reasoningChars: number;
  hasReasoning: boolean;
  lossyReasons: string[];
}

export function labelRecord(record: Qwen35Record): LabelInfo {
  const toolCallCount = record.messages
    .filter((message) => message.role === 'assistant')
    .reduce((sum, message) => sum + (message.tool_calls?.length ?? 0), 0);
  const toolMessageCount = record.messages.filter((message) => message.role === 'tool').length;
  const dialogueRounds = record.messages.filter((message) => message.role === 'user').length;
  const reasoningChars = record.messages
    .filter((message): message is Extract<Qwen35Record['messages'][number], { role: 'assistant' }> => message.role === 'assistant')
    .reduce((sum, message) => sum + (typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0), 0);
  const hasReasoning = reasoningChars > 0;
  const lossyReasons = record.meta.lossy_reasons;
  const promptOnly = lossyReasons.includes('prompt_history_only');
  const agentic = toolCallCount >= 1 && toolMessageCount >= 1 && dialogueRounds >= 1;

  let label: Label = 'discard';
  if (promptOnly) label = 'prompt_only';
  else if (agentic && hasReasoning) label = 'cot_eligible';
  else if (agentic) label = 'agent_only';

  return { label, toolCallCount, toolMessageCount, dialogueRounds, reasoningChars, hasReasoning, lossyReasons };
}
