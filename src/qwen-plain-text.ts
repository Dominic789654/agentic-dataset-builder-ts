import { createHash } from 'node:crypto';
import {
  QWEN_PLAIN_TEXT_CODEC_VERSION,
} from './roundtrip.js';
import {
  composeQwen35PlainText,
  parseQwen35PlainTextArtifact,
  Qwen35PlainTextMetadataSchema,
} from './schemas/qwen-plain-text.js';
import { Qwen35RecordSchema, type Qwen35Record } from './schemas/qwen35.js';
import { canonicalizeJson, parseCanonicalJson, toCanonicalJson } from './utils/canonical-json.js';

const QWEN_TOOL_PROMPT = `# Tools

You have access to the following functions:

<tools>`;
const QWEN_TOOL_INSTRUCTIONS = `</tools>

If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>
</tool_call>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags
- Required parameters MUST be specified
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls
</IMPORTANT>`;

type RenderOptions = {
  addGenerationPrompt?: boolean;
  addVisionId?: boolean;
  enableThinking?: boolean;
};

type RenderState = {
  imageCount: number;
  videoCount: number;
};

export function qwen35RecordToPlainText(input: Qwen35Record): string {
  const record = normalizeQwen35Record(input);
  const body = renderQwen35Body(record);
  const metadata = Qwen35PlainTextMetadataSchema.parse({
    codec_version: QWEN_PLAIN_TEXT_CODEC_VERSION,
    body_sha256: sha256(body),
    qwen_record_json: JSON.stringify(record),
  });
  return composeQwen35PlainText(body, metadata);
}

export function plainTextToQwen35Record(input: string): Qwen35Record {
  let artifact;
  try {
    artifact = parseQwen35PlainTextArtifact(input);
  } catch (error) {
    if (error instanceof Error && error.message.includes('metadata.body_sha256 must match the plaintext body')) {
      throw new Error('plain-text body hash mismatch');
    }
    throw error;
  }

  const { body, metadata: parsedMetadata } = artifact;
  if (parsedMetadata.codec_version !== QWEN_PLAIN_TEXT_CODEC_VERSION) {
    throw new Error(`unsupported plain-text codec version: ${parsedMetadata.codec_version}`);
  }
  if (parsedMetadata.body_sha256 !== sha256(body)) {
    throw new Error('plain-text body hash mismatch');
  }

  const record = normalizeQwen35Record(parseCanonicalJson<Qwen35Record>(parsedMetadata.qwen_record_json));
  const reRenderedBody = renderQwen35Body(record);
  if (reRenderedBody !== body) {
    throw new Error('plain-text body does not match canonical rendering for embedded Qwen record');
  }
  return record;
}

export function renderQwen35Body(input: Qwen35Record, options: RenderOptions = {}): string {
  const record = normalizeQwen35Record(input);
  const parts: string[] = [];
  const firstMessage = record.messages[0];
  const hasTools = record.tools.length > 0;
  const state: RenderState = { imageCount: 0, videoCount: 0 };

  if (hasTools) {
    parts.push('<|im_start|>system\n');
    parts.push(QWEN_TOOL_PROMPT);
    for (const tool of record.tools) {
      parts.push(`\n${toTemplateJson(tool)}`);
    }
    parts.push(`\n${QWEN_TOOL_INSTRUCTIONS}`);
    if (firstMessage?.role === 'system') {
      const content = renderContent(firstMessage.content, state, false, true, options).trim();
      if (content) {
        parts.push(`\n\n${content}`);
      }
    }
    parts.push('<|im_end|>\n');
  } else if (firstMessage?.role === 'system') {
    const content = renderContent(firstMessage.content, state, false, true, options).trim();
    parts.push(`<|im_start|>system\n${content}<|im_end|>\n`);
  }

  const lastQueryIndex = findLastQueryIndex(record.messages);

  record.messages.forEach((message, index) => {
    let content = renderContent(message.content, state, true, message.role === 'system', options).trim();
    if (message.role === 'system') {
      if (index !== 0) {
        throw new Error('system messages must be at the beginning');
      }
      return;
    }

    if (message.role === 'user') {
      parts.push(`<|im_start|>user\n${content}<|im_end|>\n`);
      return;
    }

    if (message.role === 'assistant') {
      const { reasoningContent, visibleContent } = splitAssistantContent(content, message.reasoning_content);
      content = visibleContent;
      parts.push('<|im_start|>assistant\n');
      if (index > lastQueryIndex) {
        parts.push(`<think>\n${reasoningContent}\n</think>\n\n${content}`);
      } else {
        parts.push(content);
      }
      if (message.tool_calls?.length) {
        for (const [toolIndex, toolCall] of message.tool_calls.entries()) {
          const prefix = toolIndex === 0 && content.trim() ? '\n\n' : toolIndex === 0 ? '' : '\n';
          parts.push(`${prefix}<tool_call>\n<function=${toolCall.function.name}>\n`);
          for (const [argumentName, argumentValue] of Object.entries(toolCall.function.arguments)) {
            parts.push(`<parameter=${argumentName}>\n${formatToolArgument(argumentValue)}\n</parameter>\n`);
          }
          parts.push('</function>\n</tool_call>');
        }
      }
      parts.push('<|im_end|>\n');
      return;
    }

    const previousMessage = record.messages[index - 1];
    if (!previousMessage || previousMessage.role !== 'tool') {
      parts.push('<|im_start|>user');
    }
    parts.push(`\n<tool_response>\n${content}\n</tool_response>`);
    const nextMessage = record.messages[index + 1];
    if (!nextMessage || nextMessage.role !== 'tool') {
      parts.push('<|im_end|>\n');
    }
  });

  if (options.addGenerationPrompt) {
    parts.push('<|im_start|>assistant\n');
    if (options.enableThinking === false) {
      parts.push('<think>\n\n</think>\n\n');
    } else {
      parts.push('<think>\n');
    }
  }

  return parts.join('');
}

function findLastQueryIndex(messages: Qwen35Record['messages']): number {
  let multiStepTool = true;
  let lastQueryIndex = messages.length - 1;

  for (let reverseIndex = messages.length - 1; reverseIndex >= 0; reverseIndex -= 1) {
    const message = messages[reverseIndex];
    if (!multiStepTool || message.role !== 'user') {
      continue;
    }
    const content = renderContent(message.content, { imageCount: 0, videoCount: 0 }, false, false, {}).trim();
    const isToolResponseEnvelope = content.startsWith('<tool_response>') && content.endsWith('</tool_response>');
    if (!isToolResponseEnvelope) {
      multiStepTool = false;
      lastQueryIndex = reverseIndex;
    }
  }

  if (multiStepTool) {
    throw new Error('no user query found in messages');
  }

  return lastQueryIndex;
}

function renderContent(
  content: Qwen35Record['messages'][number]['content'],
  state: RenderState,
  doVisionCount: boolean,
  isSystemContent: boolean,
  options: RenderOptions,
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((item) => {
      if (item.type === 'image') {
        if (isSystemContent) {
          throw new Error('system messages cannot contain images');
        }
        if (doVisionCount) {
          state.imageCount += 1;
        }
        const prefix = options.addVisionId ? `Picture ${state.imageCount}: ` : '';
        return `${prefix}<|vision_start|><|image_pad|><|vision_end|>`;
      }
      if (item.type === 'video') {
        if (isSystemContent) {
          throw new Error('system messages cannot contain videos');
        }
        if (doVisionCount) {
          state.videoCount += 1;
        }
        const prefix = options.addVisionId ? `Video ${state.videoCount}: ` : '';
        return `${prefix}<|vision_start|><|video_pad|><|vision_end|>`;
      }
      return item.text;
    })
    .join('');
}

function splitAssistantContent(content: string, reasoningContent: string | undefined): { reasoningContent: string; visibleContent: string } {
  if (typeof reasoningContent === 'string') {
    return {
      reasoningContent: reasoningContent.trim(),
      visibleContent: content,
    };
  }

  if (!content.includes('</think>')) {
    return {
      reasoningContent: '',
      visibleContent: content,
    };
  }

  const [reasoningSegment, ...rest] = content.split('</think>');
  const extractedReasoning = reasoningSegment?.split('<think>').at(-1)?.replace(/^\n+/, '').replace(/\n+$/, '') ?? '';
  return {
    reasoningContent: extractedReasoning.trim(),
    visibleContent: rest.join('</think>').replace(/^\n+/, ''),
  };
}

function formatToolArgument(value: unknown): string {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return toTemplateJson(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (value === null) {
    return 'None';
  }
  return String(value);
}

function toTemplateJson(value: unknown): string {
  return serializeTemplateJson(canonicalizeJson(value));
}

function serializeTemplateJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTemplateJson(item)).join(', ')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${serializeTemplateJson(item)}`);
    return `{${entries.join(', ')}}`;
  }

  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeQwen35Record(input: Qwen35Record): Qwen35Record {
  return Qwen35RecordSchema.parse(input);
}
