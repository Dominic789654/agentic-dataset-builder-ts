import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectCodexRecords, collectCodexTrajectories } from './codex.js';

describe('collectCodexTrajectories', () => {
  it('builds source-native trajectories for a turn with reasoning, tool calls, and final assistant text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 's1', cwd: '/tmp/project', model: 'codex-test' } }),
        JSON.stringify({ type: 'turn_context', timestamp: '2026-01-01T00:00:00Z', payload: { model: 'codex-turn', effort: 'high' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn-1' } }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:02Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:03Z',
          payload: { type: 'reasoning', summary: [{ text: 'reasoning' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:04Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:05Z',
          payload: { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"README.md"}' },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:06Z',
          payload: { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-01-01T00:00:07Z',
          payload: { type: 'task_complete', last_agent_message: 'done' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const trajectories = await collectCodexTrajectories(dir);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].steps.map((step) => step.source)).toEqual(['user', 'agent', 'agent']);
    expect(trajectories[0].steps[1]?.reasoning_content).toBe('reasoning');
    expect(trajectories[0].steps[1]?.tool_calls?.[0]?.function_name).toBe('Read');
    expect(trajectories[0].steps[1]?.observation?.results[0]?.content).toBe('file contents');
    expect(trajectories[0].steps[2]?.message).toBe('done');

    const records = await collectCodexRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    if (records[0].messages[1]?.role !== 'assistant') throw new Error('expected assistant message');
    expect(records[0].messages[1].reasoning_content).toBe('reasoning');
    expect(records[0].messages[2]?.content).toBe('file contents');
    expect(records[0].messages[3]?.content).toBe('done');
  });

  it('keeps exec_command_end as a tool-only projection when no visible assistant text exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 's2', cwd: '/tmp/project', model: 'codex-test' } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'task_started', turn_id: 'turn-2' } }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-01-01T00:00:02Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-01-01T00:00:03Z',
          payload: {
            type: 'exec_command_end',
            call_id: 'exec_1',
            command: 'ls',
            cwd: '/tmp/project',
            aggregated_output: 'README.md',
            exit_code: 0,
            status: 'completed',
            duration: 1,
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-01-01T00:00:04Z',
          payload: { type: 'task_complete', last_agent_message: 'done' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const trajectories = await collectCodexTrajectories(dir);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0].steps[1]?.tool_calls?.[0]?.function_name).toBe('exec_command');
    expect(trajectories[0].steps[1]?.observation?.results[0]?.content).toContain('"command":"ls"');

    const records = await collectCodexRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant']);
    if (records[0].messages[1]?.role !== 'tool') throw new Error('expected tool message');
    expect(records[0].messages[1].tool_call_id).toBe('exec_1');
    expect(records[0].messages[2]?.content).toBe('done');
  });
});
