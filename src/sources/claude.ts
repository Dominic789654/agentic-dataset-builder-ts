import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { Qwen35RecordSchema, type Qwen35Record } from '../schemas/qwen35.js';
import { ClaudeProjectEntrySchema, type ClaudeProjectEntry } from '../schemas/source.js';
import { readJsonl } from '../utils/jsonl.js';

type Qwen35Message = Qwen35Record['messages'][number];
type AssistantMessage = Extract<Qwen35Message, { role: 'assistant' }>;
type ToolMessage = Extract<Qwen35Message, { role: 'tool' }>;
type UserMessage = Extract<Qwen35Message, { role: 'user' }>;
type SystemMessage = Extract<Qwen35Message, { role: 'system' }>;
type ClaudeEnvelope = Record<string, unknown>;

interface ToolResultEntry {
  content: unknown;
  isError: boolean;
}

interface SidecarPoolEntry {
  key: string;
  content: Qwen35Message['content'];
  claimed: boolean;
}

interface SidecarStore {
  directByPrefix: Map<string, Qwen35Message['content']>;
  unclaimed: SidecarPoolEntry[];
}

interface SubagentArtifact {
  agentId: string;
  messages: Qwen35Message[];
  firstUserText?: string;
  claimed: boolean;
}

interface ClaudeMetadata {
  sessionId: string;
  cwd?: string;
  version?: string;
  requestedModel?: string;
  actualModel?: string;
  status: number;
  timestamps: string[];
  inlineSubagentIds: Set<string>;
  toolDefinitions: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  hasSubagents: boolean;
  subagentFiles: string[];
  sidecarToolResultsDir?: string;
}

interface ContentExtraction {
  content?: Qwen35Message['content'];
  hasOnlyToolResults: boolean;
  imageCount: number;
  videoCount: number;
}

interface AssistantExtraction {
  message: AssistantMessage;
  trailingMessages: Qwen35Message[];
  imageCount: number;
  videoCount: number;
  missingToolResultCount: number;
}

export async function collectClaudePromptOnlyRecords(root: string): Promise<Qwen35Record[]> {
  const files = (await fg('**/*.jsonl', { cwd: root, absolute: true, onlyFiles: true }))
    .filter((file) => !file.includes(`${path.sep}subagents${path.sep}`))
    .sort();

  const records: Qwen35Record[] = [];
  for (const file of files) {
    const entries = (await readJsonl(file)).map((row) => ClaudeProjectEntrySchema.parse(row));
    const record = buildClaudeSessionRecord(entries, file);
    if (record) {
      records.push(Qwen35RecordSchema.parse(record));
      continue;
    }
    for (const fallback of buildPromptOnlyFallbackRecords(entries, file)) {
      records.push(Qwen35RecordSchema.parse(fallback));
    }
  }
  return records;
}

function buildClaudeSessionRecord(entries: ClaudeProjectEntry[], file: string): Qwen35Record | null {
  const envelopes = unwrapClaudeEntries(entries);
  const metadata = extractMetadata(envelopes, file);
  const lossyReasons = new Set<string>();

  const sidecarStore = buildSidecarStore(metadata.sidecarToolResultsDir);
  if (metadata.sidecarToolResultsDir && (sidecarStore.directByPrefix.size > 0 || sidecarStore.unclaimed.length > 0)) {
    lossyReasons.add('tool_result_sidecar_partially_loaded');
  }

  const toolResultMap = buildToolResultMap(envelopes, sidecarStore);
  const tools = new Map<string, { name: string; description?: string; parameters?: Record<string, unknown> }>();
  for (const definition of metadata.toolDefinitions) {
    tools.set(definition.name, definition);
  }
  const subagentArtifacts = loadSubagentArtifacts(metadata.subagentFiles, tools, lossyReasons);
  if (metadata.hasSubagents && subagentArtifacts.length === 0) lossyReasons.add('subagents_not_inlined');

  const messages: Qwen35Message[] = [];
  let requestImageBlockCount = 0;
  let requestVideoBlockCount = 0;
  let responseImageBlockCount = 0;
  let responseVideoBlockCount = 0;
  let assistantCount = 0;
  let seenNonSystem = false;
  const loadedSubagentIds = new Set(metadata.inlineSubagentIds);

  for (const envelope of envelopes) {
    if (envelope.isMeta === true) continue;
    const message = isRecord(envelope.message) ? envelope.message : undefined;
    if (!message) continue;
    const role = asString(message.role);
    const subagentId = asString(envelope.__agentId);

    if (role === 'system') {
      const extracted = extractMessageContent(message.content, lossyReasons, 'system');
      if (!extracted.content || extracted.hasOnlyToolResults) continue;
      const systemMessage: SystemMessage = { role: 'system', content: extracted.content };
      if (!seenNonSystem) {
        messages.push(systemMessage);
      } else {
        lossyReasons.add('interleaved_system_rows');
        messages.push({ role: 'assistant', content: stringifyContent(systemMessage.content, '[system_row]') });
      }
      continue;
    }

    if (role === 'user') {
      seenNonSystem = true;
      const extracted = extractMessageContent(message.content, lossyReasons, 'user');
      requestImageBlockCount += extracted.imageCount;
      requestVideoBlockCount += extracted.videoCount;
      if (extracted.content && !extracted.hasOnlyToolResults) {
        const userMessage: UserMessage = { role: 'user', content: extracted.content };
        if (subagentId) {
          userMessage.content = prependSubagentMarker(userMessage.content, subagentId);
          loadedSubagentIds.add(subagentId);
        }
        messages.push(userMessage);
      }
      continue;
    }

    if (role === 'assistant') {
      seenNonSystem = true;
      const extracted = extractAssistantMessage(message.content, toolResultMap, tools, lossyReasons, subagentArtifacts, sidecarStore);
      responseImageBlockCount += extracted.imageCount;
      responseVideoBlockCount += extracted.videoCount;
      if (extracted.missingToolResultCount > 0) lossyReasons.add('missing_tool_results');
      if (subagentId) {
        extracted.message.content = prependSubagentMarker(extracted.message.content, subagentId);
        if (extracted.message.reasoning_content) {
          extracted.message.reasoning_content = `[subagent:${subagentId}]\n${extracted.message.reasoning_content}`;
        }
        loadedSubagentIds.add(subagentId);
      }
      messages.push(extracted.message, ...extracted.trailingMessages);
      assistantCount += 1;
    }
  }

  const fallbackArtifacts = subagentArtifacts.filter((artifact) => !loadedSubagentIds.has(artifact.agentId) && !artifact.claimed);
  if (fallbackArtifacts.length > 0) {
    for (const artifact of fallbackArtifacts) {
      messages.push(...artifact.messages.map((message) => ({
        ...message,
        content: prependSubagentMarker(message.content, artifact.agentId),
      })));
    }
    lossyReasons.add('subagents_appended_from_side_files');
  }

  if (assistantCount === 0 || !messages.some((message) => message.role === 'user')) {
    return null;
  }

  return {
    id: metadata.sessionId,
    request_id: metadata.sessionId,
    messages,
    tools: [...tools.values()],
    meta: {
      endpoint: 'claude/session_trace',
      status: metadata.status,
      ts: metadata.timestamps.at(-1) ?? '',
      key: metadata.sessionId,
      source: `claude:session=${metadata.sessionId}:cwd=${metadata.cwd ?? ''}:file=${file}`,
      requested_model: metadata.requestedModel,
      actual_model: metadata.actualModel,
      stream: false,
      thinking_level: undefined,
      reasoning_summary_mode: 'claude_session_trace',
      thinking_type: 'claude_session',
      thinking_budget_tokens: undefined,
      max_output_tokens: undefined,
      tool_spec_count: tools.size,
      tool_choice: { mode: 'session_trace' },
      request_contains_non_text_content: requestImageBlockCount > 0 || requestVideoBlockCount > 0,
      request_image_block_count: requestImageBlockCount,
      request_video_block_count: requestVideoBlockCount,
      request_tool_call_block_count: 0,
      request_tool_result_block_count: 0,
      request_thinking_block_count: 0,
      response_contains_non_text_content: responseImageBlockCount > 0 || responseVideoBlockCount > 0,
      response_image_block_count: responseImageBlockCount,
      response_video_block_count: responseVideoBlockCount,
      response_tool_call_block_count: messages
        .filter((message): message is AssistantMessage => message.role === 'assistant')
        .reduce((sum, message) => sum + (message.tool_calls?.length ?? 0), 0),
      response_tool_result_block_count: messages.filter((message) => message.role === 'tool').length,
      response_thinking_block_count: messages.filter((message) => message.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0).length,
      request_truncated: false,
      response_truncated: false,
      lossy_source: lossyReasons.size > 0,
      lossy_reasons: [...lossyReasons],
    },
  };
}

function buildPromptOnlyFallbackRecords(entries: ClaudeProjectEntry[], file: string): Qwen35Record[] {
  const records: Qwen35Record[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const message = isRecord(entry.message) ? entry.message : {};
    const content = asString(message.content);
    if (!content) continue;
    records.push({
      id: `${asString(entry.sessionId) ?? file}:${asString(entry.promptId) ?? asString(entry.uuid) ?? 'prompt'}`,
      request_id: asString(entry.promptId) ?? asString(entry.uuid) ?? undefined,
      messages: [{ role: 'user', content }],
      tools: [],
      meta: {
        endpoint: 'claude/prompt_history',
        status: 200,
        ts: asString(entry.timestamp) ?? '',
        key: asString(entry.sessionId) ?? undefined,
        source: `claude:session=${asString(entry.sessionId) ?? ''}:cwd=${asString(entry.cwd) ?? ''}:entrypoint=${asString(entry.entrypoint) ?? ''}`,
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
    });
  }
  return records;
}

function unwrapClaudeEntries(entries: ClaudeProjectEntry[]): ClaudeEnvelope[] {
  const envelopes: ClaudeEnvelope[] = [];
  for (const entry of entries) {
    if (isTranscriptEnvelope(entry)) {
      envelopes.push(entry);
    }
    const nested = extractProgressEnvelope(entry);
    if (nested) envelopes.push(nested);
  }
  return envelopes;
}

function buildToolResultMap(envelopes: ClaudeEnvelope[], sidecarStore: SidecarStore): Map<string, ToolResultEntry> {
  const map = new Map<string, ToolResultEntry>();
  for (const envelope of envelopes) {
    const message = isRecord(envelope.message) ? envelope.message : undefined;
    if (!message || asString(message.role) !== 'user') continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (!isRecord(rawBlock) || asString(rawBlock.type) !== 'tool_result') continue;
      const toolUseId = asString(rawBlock.tool_use_id);
      if (!toolUseId || map.has(toolUseId)) continue;
      map.set(toolUseId, {
        content: rawBlock.content,
        isError: Boolean(rawBlock.is_error),
      });
    }
  }
  for (const [toolUseId, entry] of map) {
    if (entry.content !== undefined && entry.content !== null && entry.content !== '') continue;
    const sidecarContent = claimSidecarByToolUseId(sidecarStore, toolUseId);
    if (sidecarContent !== undefined) {
      map.set(toolUseId, { content: sidecarContent, isError: entry.isError });
    }
  }
  return map;
}

function extractMetadata(envelopes: ClaudeEnvelope[], file: string): ClaudeMetadata {
  const sessionId = envelopes.map((envelope) => asString(envelope.sessionId)).find(Boolean) ?? path.basename(file, '.jsonl');
  const timestamps = envelopes.map((envelope) => asString(envelope.timestamp)).filter((value): value is string => Boolean(value));
  const toolDefinitions = new Map<string, { name: string; description?: string; parameters?: Record<string, unknown> }>();
  let cwd: string | undefined;
  let version: string | undefined;
  let requestedModel: string | undefined;
  let actualModel: string | undefined;
  let status = 200;
  const inlineSubagentIds = new Set<string>();

  for (const envelope of envelopes) {
    cwd ??= asString(envelope.cwd);
    version ??= asString(envelope.version) ?? asString(envelope.claude_code_version);
    const inlineSubagentId = asString(envelope.__agentId);
    if (inlineSubagentId) inlineSubagentIds.add(inlineSubagentId);

    if (asString(envelope.type) === 'system' && asString(envelope.subtype) === 'init') {
      requestedModel ??= asString(envelope.model);
      actualModel ??= asString(envelope.model);
      const tools = Array.isArray(envelope.tools) ? envelope.tools : [];
      for (const rawTool of tools) {
        if (!isRecord(rawTool)) continue;
        const name = asString(rawTool.name);
        if (!name) continue;
        toolDefinitions.set(name, {
          name,
          description: asString(rawTool.description),
          parameters: isRecord(rawTool.parameters) ? rawTool.parameters : undefined,
        });
      }
    }

    if (asString(envelope.type) === 'result') {
      const subtype = asString(envelope.subtype) ?? '';
      if (subtype.startsWith('error')) status = 500;
    }

    const message = isRecord(envelope.message) ? envelope.message : undefined;
    if (message) {
      actualModel ??= asString(message.model);
      requestedModel ??= asString(message.model);
    }
  }

  const sessionDir = path.join(path.dirname(file), path.basename(file, '.jsonl'));
  const subagentsDir = path.join(sessionDir, 'subagents');
  const toolResultsDir = path.join(sessionDir, 'tool-results');
  const subagentFiles = fs.existsSync(subagentsDir)
    ? fs.readdirSync(subagentsDir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(subagentsDir, name))
    : [];

  return {
    sessionId,
    cwd,
    version,
    requestedModel,
    actualModel,
    status,
    timestamps,
    inlineSubagentIds,
    toolDefinitions: [...toolDefinitions.values()],
    hasSubagents: subagentFiles.length > 0,
    subagentFiles,
    sidecarToolResultsDir: fs.existsSync(toolResultsDir) ? toolResultsDir : undefined,
  };
}

function extractMessageContent(content: unknown, lossyReasons: Set<string>, prefix: string): ContentExtraction {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return {
      content: trimmed || undefined,
      hasOnlyToolResults: false,
      imageCount: 0,
      videoCount: 0,
    };
  }

  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) {
      lossyReasons.add(`${prefix}_nonstandard_content`);
      return {
        content: JSON.stringify(content),
        hasOnlyToolResults: false,
        imageCount: 0,
        videoCount: 0,
      };
    }
    return { hasOnlyToolResults: false, imageCount: 0, videoCount: 0 };
  }

  const blocks: Array<Record<string, unknown>> = [];
  let imageCount = 0;
  let videoCount = 0;
  let hasToolResults = false;
  let hasVisibleContent = false;

  for (const rawBlock of content) {
    if (!isRecord(rawBlock)) continue;
    const type = asString(rawBlock.type);
    if (type === 'text') {
      const text = asString(rawBlock.text)?.trim();
      if (!text) continue;
      blocks.push({ type: 'text', text });
      hasVisibleContent = true;
      continue;
    }
    if (type === 'tool_result') {
      hasToolResults = true;
      continue;
    }
    if (type === 'image') {
      blocks.push({ type: 'image', placeholder: true, source_kind: 'claude_image', metadata: { source_type: type } });
      imageCount += 1;
      hasVisibleContent = true;
      continue;
    }
    if (type === 'video') {
      blocks.push({ type: 'video', placeholder: true, source_kind: 'claude_video', metadata: { source_type: type } });
      videoCount += 1;
      hasVisibleContent = true;
      continue;
    }
    if (type) lossyReasons.add(`${prefix}_unsupported_block_${sanitizeLossyReason(type)}`);
    else lossyReasons.add(`${prefix}_unsupported_block_unknown`);
  }

  return {
    content: collapseBlocks(blocks),
    hasOnlyToolResults: hasToolResults && !hasVisibleContent,
    imageCount,
    videoCount,
  };
}

function extractAssistantMessage(
  content: unknown,
  toolResultMap: Map<string, ToolResultEntry>,
  tools: Map<string, { name: string; description?: string; parameters?: Record<string, unknown> }>,
  lossyReasons: Set<string>,
  subagentArtifacts: SubagentArtifact[],
  sidecarStore: SidecarStore,
): AssistantExtraction {
  const textBlocks: Array<Record<string, unknown>> = [];
  const reasoning: string[] = [];
  const toolCalls: NonNullable<AssistantMessage['tool_calls']> = [];
  const trailingMessages: Qwen35Message[] = [];
  let imageCount = 0;
  let videoCount = 0;
  let missingToolResultCount = 0;

  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed) textBlocks.push({ type: 'text', text: trimmed });
  } else if (Array.isArray(content)) {
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) continue;
      const type = asString(rawBlock.type);
      if (type === 'text') {
        const text = asString(rawBlock.text)?.trim();
        if (text) textBlocks.push({ type: 'text', text });
        continue;
      }
      if (type === 'thinking') {
        const text = sanitizeThinking(asString(rawBlock.thinking));
        if (text) reasoning.push(text);
        else if (asString(rawBlock.signature)) lossyReasons.add('encrypted_reasoning_without_visible_text');
        continue;
      }
      if (type === 'tool_use') {
        const id = asString(rawBlock.id);
        const name = asString(rawBlock.name) ?? 'tool';
        const input = isRecord(rawBlock.input) ? rawBlock.input : {};
        toolCalls.push({
          type: 'function',
          id,
          function: {
            name,
            arguments: input,
          },
        });
        if (!tools.has(name)) tools.set(name, { name });
        if (id) {
          const sidecarContent = claimSidecarByToolUseId(sidecarStore, id);
          const result = toolResultMap.get(id) ?? (sidecarContent !== undefined ? { content: sidecarContent, isError: false } : undefined);
          if (result && result.content !== undefined) {
            trailingMessages.push({
              role: 'tool',
              name,
              tool_call_id: id,
              content: formatToolResultContent(result.content, result.isError, lossyReasons),
            });
          } else {
            missingToolResultCount += 1;
          }
        }
        if (name === 'Task' || name === 'Agent') {
          const artifact = claimMatchingSubagentArtifact(input, subagentArtifacts);
          if (artifact) {
            trailingMessages.push(...artifact.messages.map((message) => ({
              ...message,
              content: prependSubagentMarker(message.content, artifact.agentId),
            })));
          }
        }
        continue;
      }
      if (type === 'image') {
        textBlocks.push({ type: 'image', placeholder: true, source_kind: 'claude_image', metadata: { source_type: type } });
        imageCount += 1;
        continue;
      }
      if (type === 'video') {
        textBlocks.push({ type: 'video', placeholder: true, source_kind: 'claude_video', metadata: { source_type: type } });
        videoCount += 1;
        continue;
      }
      if (type) lossyReasons.add(`assistant_unsupported_block_${sanitizeLossyReason(type)}`);
      else lossyReasons.add('assistant_unsupported_block_unknown');
    }
  } else if (content !== undefined && content !== null) {
    lossyReasons.add('assistant_nonstandard_content');
    textBlocks.push({ type: 'text', text: JSON.stringify(content) });
  }

  const assistant: AssistantMessage = {
    role: 'assistant',
    content: collapseBlocks(textBlocks) ?? '',
  };
  if (reasoning.length) assistant.reasoning_content = reasoning.join('\n\n');
  if (toolCalls.length) assistant.tool_calls = toolCalls;

  return { message: assistant, trailingMessages, imageCount, videoCount, missingToolResultCount };
}

function loadSubagentArtifacts(
  subagentFiles: string[],
  tools: Map<string, { name: string; description?: string; parameters?: Record<string, unknown> }>,
  lossyReasons: Set<string>,
): SubagentArtifact[] {
  const artifacts: SubagentArtifact[] = [];
  for (const file of subagentFiles) {
    try {
      const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ClaudeProjectEntry);
      const record = buildClaudeSessionRecord(rows, file);
      if (!record) continue;
      for (const tool of record.tools) {
        if (!tools.has(tool.name)) tools.set(tool.name, tool);
      }
      const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
      const firstUserText = record.messages.find((message) => message.role === 'user');
      artifacts.push({
        agentId,
        messages: record.messages.filter((message) => message.role !== 'system'),
        firstUserText: firstUserText && typeof firstUserText.content === 'string' ? firstUserText.content : undefined,
        claimed: false,
      });
    } catch {
      lossyReasons.add('subagent_parse_failed');
    }
  }
  return artifacts;
}

function prependSubagentMarker(content: Qwen35Message['content'], subagentId?: string): Qwen35Message['content'] {
  const marker = subagentId ? `[subagent:${subagentId}]` : '[subagent]';
  if (typeof content === 'string') return `${marker}\n${content}`;
  return [{ type: 'text', text: marker }, ...content];
}

function claimMatchingSubagentArtifact(input: Record<string, unknown>, artifacts: SubagentArtifact[]): SubagentArtifact | undefined {
  const prompt = asString(input.prompt)?.trim();
  const description = asString(input.description)?.trim();
  if (prompt) {
    const exact = artifacts.find((artifact) => !artifact.claimed && artifact.firstUserText?.trim() === prompt);
    if (exact) {
      exact.claimed = true;
      return exact;
    }
  }
  if (description) {
    const fuzzy = artifacts.find((artifact) => !artifact.claimed && artifact.firstUserText?.includes(description));
    if (fuzzy) {
      fuzzy.claimed = true;
      return fuzzy;
    }
  }
  const fallback = artifacts.find((artifact) => !artifact.claimed);
  if (fallback) {
    fallback.claimed = true;
    return fallback;
  }
  return undefined;
}

function buildSidecarStore(sidecarToolResultsDir?: string): SidecarStore {
  const store: SidecarStore = { directByPrefix: new Map(), unclaimed: [] };
  if (!sidecarToolResultsDir || !fs.existsSync(sidecarToolResultsDir)) return store;
  for (const name of fs.readdirSync(sidecarToolResultsDir).sort()) {
    const fullPath = path.join(sidecarToolResultsDir, name);
    const content = readSidecarEntry(fullPath);
    if (content === undefined) continue;
    const key = name;
    if (name.startsWith('toolu_') || name.startsWith('tooluse_')) store.directByPrefix.set(name, content);
    else store.unclaimed.push({ key, content, claimed: false });
  }
  return store;
}

function claimSidecarByToolUseId(store: SidecarStore, toolUseId: string): Qwen35Message['content'] | undefined {
  const direct = [...store.directByPrefix.entries()].find(([prefix]) => prefix.startsWith(toolUseId));
  if (direct) {
    store.directByPrefix.delete(direct[0]);
    return direct[1];
  }
  if (store.unclaimed.length === 1 && !store.unclaimed[0].claimed) {
    store.unclaimed[0].claimed = true;
    return store.unclaimed[0].content;
  }
  return undefined;
}

function readSidecarEntry(fullPath: string): Qwen35Message['content'] | undefined {
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return fs.readFileSync(fullPath, 'utf8');
  if (stat.isDirectory()) return loadSidecarDirectoryContent(fullPath);
  return undefined;
}

function loadSidecarDirectoryContent(dirPath: string): Qwen35Message['content'] | undefined {
  const files = fs.readdirSync(dirPath).sort();
  const blocks: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif') {
      blocks.push({
        type: 'image',
        placeholder: true,
        source_kind: 'claude_tool_result_sidecar_image',
        metadata: { path: path.join(dirPath, file) },
      });
    }
  }
  return blocks.length > 0 ? (blocks as Qwen35Message['content']) : undefined;
}

function formatToolResultContent(content: unknown, isError: boolean, lossyReasons: Set<string>): ToolMessage['content'] {
  const base = normalizeToolResultContent(content, lossyReasons);
  if (!isError) return base;
  if (typeof base === 'string') {
    return JSON.stringify({ content: base, error: true });
  }
  return JSON.stringify({ content: base, error: true });
}

function normalizeToolResultContent(content: unknown, lossyReasons: Set<string>): ToolMessage['content'] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.every((block) => isRecord(block) && isQwenBlockType(asString(block.type)))) {
      return content as ToolMessage['content'];
    }
    const textParts: string[] = [];
    let hasNonText = false;
    for (const rawBlock of content) {
      if (!isRecord(rawBlock)) {
        hasNonText = true;
        continue;
      }
      const type = asString(rawBlock.type);
      if (type === 'text') {
        const text = asString(rawBlock.text);
        if (text) textParts.push(text);
      } else {
        hasNonText = true;
      }
    }
    if (!hasNonText) return textParts.join('\n\n');
    lossyReasons.add('tool_result_non_text_content');
  }
  return JSON.stringify(content);
}

function isQwenBlockType(value: string | undefined): value is 'text' | 'image' | 'video' {
  return value === 'text' || value === 'image' || value === 'video';
}

function extractProgressEnvelope(entry: ClaudeProjectEntry): ClaudeEnvelope | null {
  if (entry.type !== 'progress') return null;
  const data = isRecord(entry.data) ? entry.data : undefined;
  const wrapped = data && isRecord(data.message) ? data.message : undefined;
  if (!wrapped) return null;
  const agentId = asString(entry.agentId);
  return agentId ? { ...wrapped, __agentId: agentId } : wrapped;
}

function isTranscriptEnvelope(entry: ClaudeProjectEntry): entry is ClaudeProjectEntry & ClaudeEnvelope {
  const type = asString(entry.type);
  return type === 'user' || type === 'assistant' || type === 'system' || type === 'result';
}

function collapseBlocks(blocks: Array<Record<string, unknown>>): Qwen35Message['content'] | undefined {
  if (blocks.length === 0) return undefined;
  if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
    return blocks[0].text;
  }
  return blocks as Qwen35Message['content'];
}

function stringifyContent(content: Qwen35Message['content'], prefix: string): string {
  return `${prefix}\n${typeof content === 'string' ? content : JSON.stringify(content)}`;
}

function sanitizeThinking(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/<\/?think>/gi, '').trim();
  return cleaned || undefined;
}

function sanitizeLossyReason(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
