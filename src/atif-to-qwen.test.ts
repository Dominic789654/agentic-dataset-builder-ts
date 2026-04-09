import { describe, expect, it } from 'vitest';
import { atifTrajectoryToQwen35Record } from './atif-to-qwen.js';
import { qwen35RecordToAtifTrajectory } from './qwen-to-atif.js';
import { canonicalAtifFixture, canonicalAtifStressFixture } from './roundtrip-fixtures.js';
import { toCanonicalJson } from './utils/canonical-json.js';

describe('atifTrajectoryToQwen35Record', () => {
  it('projects ATIF into a Qwen35 record while preserving the exact trajectory snapshot', () => {
    const trajectory = canonicalAtifFixture();
    const record = atifTrajectoryToQwen35Record(trajectory);

    expect(record.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(record.meta.lossy_source).toBe(false);
    expect(record.meta.roundtrip?.canonical_source).toBe('atif');
    expect(record.meta.roundtrip?.atif_trajectory_json).toBe(toCanonicalJson(trajectory));

    if (record.messages[2]?.role !== 'assistant') {
      throw new Error('expected assistant message at index 2');
    }
    expect(record.messages[2].reasoning_content).toBe('Need to compare files.');
    expect(record.messages[2].tool_calls?.map((toolCall) => toolCall.function.name)).toEqual(['bash', 'Task']);

    if (record.messages[4]?.role !== 'tool') {
      throw new Error('expected tool message at index 4');
    }
    expect(record.messages[4].content).toBe('[subagent_trajectory_ref]\nsubagent-1');
  });

  it('round-trips ATIF exactly through Qwen35 records', () => {
    const trajectory = canonicalAtifFixture();
    const restored = qwen35RecordToAtifTrajectory(atifTrajectoryToQwen35Record(trajectory));
    expect(restored).toEqual(trajectory);
  });

  it('projects an ATIF stress fixture with empty agent content and multiple tool calls', () => {
    const trajectory = canonicalAtifStressFixture();
    const record = atifTrajectoryToQwen35Record(trajectory);

    expect(record.meta.roundtrip?.atif_trajectory_json).toBe(toCanonicalJson(trajectory));
    expect(record.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'tool', 'user', 'assistant']);
    if (record.messages[2]?.role !== 'assistant') {
      throw new Error('expected assistant message at index 2');
    }
    expect(record.messages[2].content).toBe('');
    expect(record.messages[2].tool_calls?.map((toolCall) => toolCall.id)).toEqual(['stress_call_1', 'stress_call_2', 'stress_call_3']);
  });
});
