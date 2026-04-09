import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectClaudePromptOnlyRecords } from './claude.js';

describe('collectClaudePromptOnlyRecords', () => {
  it('reconstructs assistant reasoning, tool calls, and tool results from Claude session jsonl', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:00Z',
          cwd: '/tmp/project',
          claude_code_version: '2.1.42',
          model: 'claude-test',
          tools: [{ name: 'Read', description: 'read files' }],
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 's1',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'progress',
          data: {
            message: {
              type: 'assistant',
              timestamp: '2026-01-01T00:00:02Z',
              message: {
                role: 'assistant',
                model: 'claude-test',
                content: [
                  { type: 'thinking', thinking: '<think>reasoning</think>' },
                  { type: 'text', text: 'answer' },
                  { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
                ],
              },
            },
          },
        }),
        JSON.stringify({
          type: 'progress',
          data: {
            message: {
              type: 'user',
              timestamp: '2026-01-01T00:00:03Z',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents', is_error: false }],
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].meta.endpoint).toBe('claude/session_trace');
    expect(records[0].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    if (records[0].messages[1]?.role !== 'assistant') throw new Error('expected assistant message');
    expect(records[0].messages[1].reasoning_content).toBe('reasoning');
    expect(records[0].messages[1].tool_calls?.[0]?.function.name).toBe('Read');
    expect(records[0].messages[2]?.role).toBe('tool');
    expect(records[0].messages[2]?.content).toBe('file contents');
  });

  it('falls back to prompt-only records when a full session cannot be reconstructed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', sessionId: 's1', promptId: 'p1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages[0]?.role).toBe('user');
    expect(records[0].meta.lossy_reasons).toContain('prompt_history_only');
  });

  it('hydrates missing tool results from sidecar files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const sessionDir = path.join(dir, 'sample');
    const toolResultsDir = path.join(sessionDir, 'tool-results');
    fs.mkdirSync(toolResultsDir, { recursive: true });
    fs.writeFileSync(path.join(toolResultsDir, 'toolu_sidecar.txt'), 'sidecar payload', 'utf8');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's2', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's2', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's2',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_sidecar', name: 'Read', input: { file_path: 'README.md' } }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(records[0].messages[2]?.content).toBe('sidecar payload');
  });

  it('hydrates image sidecars as image placeholder blocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const sessionDir = path.join(dir, 'sample');
    const toolResultsDir = path.join(sessionDir, 'tool-results', 'toolu_gallery');
    fs.mkdirSync(toolResultsDir, { recursive: true });
    fs.writeFileSync(path.join(toolResultsDir, 'page-1.jpg'), 'fake', 'utf8');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's2b', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's2b', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's2b',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_gallery', name: 'Read', input: { file_path: 'slides.pdf' } }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages[2]?.role).toBe('tool');
    expect(Array.isArray(records[0].messages[2]?.content)).toBe(true);
  });

  it('appends subagent transcripts after Task tool calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const sessionDir = path.join(dir, 'sample');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a1.jsonl'),
      [
        JSON.stringify({ type: 'user', sessionId: 'sub1', timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: 'sub task' } }),
        JSON.stringify({ type: 'assistant', sessionId: 'sub1', timestamp: '2026-01-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] } }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's3', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's3', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's3',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'delegating' },
              { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'do subtask' } },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    const textMessages = records[0].messages.map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }));
    expect(textMessages.some((message) => message.role === 'user' && message.content.includes('[subagent:a1]\nsub task'))).toBe(true);
    expect(textMessages.some((message) => message.role === 'assistant' && message.content.includes('[subagent:a1]\nsub answer'))).toBe(true);
    expect(records[0].meta.lossy_reasons).not.toContain('subagents_not_inlined');
  });


  it('does not silently claim unrelated sidecar payloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const sessionDir = path.join(dir, 'sample');
    const toolResultsDir = path.join(sessionDir, 'tool-results');
    fs.mkdirSync(toolResultsDir, { recursive: true });
    fs.writeFileSync(path.join(toolResultsDir, 'unrelated.txt'), 'orphan sidecar', 'utf8');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's5', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's5', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's5',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_missing', name: 'Read', input: { file_path: 'README.md' } }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages.some((message) => message.role === 'tool')).toBe(false);
    expect(records[0].meta.lossy_reasons).toContain('missing_tool_results');
  });

  it('falls back to side-file subagents only when inline agent ids have no usable transcript messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    const sessionDir = path.join(dir, 'sample');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a1.jsonl'),
      [
        JSON.stringify({ type: 'user', sessionId: 'sub1', timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: 'sub task' } }),
        JSON.stringify({ type: 'assistant', sessionId: 'sub1', timestamp: '2026-01-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] } }),
      ].join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's6', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's6', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's6',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'do subtask' } }],
          },
        }),
        JSON.stringify({
          type: 'progress',
          agentId: 'a1',
          data: {
            message: {
              type: 'file-history-snapshot',
              snapshot: { timestamp: '2026-01-01T00:00:03Z' },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    const textMessages = records[0].messages.map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }));
    expect(textMessages.some((message) => message.content.includes('[subagent:a1]\nsub task'))).toBe(true);
    expect(records[0].meta.lossy_reasons).toContain('subagents_appended_from_side_files');
  });

  it('prefers inline progress subagent messages with explicit agent ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'system', subtype: 'init', sessionId: 's4', timestamp: '2026-01-01T00:00:00Z', model: 'claude-test' }),
        JSON.stringify({ type: 'user', sessionId: 's4', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's4',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'do subtask' } }],
          },
        }),
        JSON.stringify({
          type: 'progress',
          agentId: 'a123456',
          data: {
            message: {
              type: 'assistant',
              timestamp: '2026-01-01T00:00:03Z',
              message: { role: 'assistant', content: [{ type: 'text', text: 'inline subagent answer' }] },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectClaudePromptOnlyRecords(dir);
    expect(records).toHaveLength(1);
    const assistantTexts = records[0].messages
      .filter((message) => message.role === 'assistant')
      .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
    expect(assistantTexts.some((text) => text.includes('[subagent:a123456]\ninline subagent answer'))).toBe(true);
  });
});
