import { describe, expect, it } from 'vitest';
import { atifTrajectoryToQwen35Record } from './atif-to-qwen.js';
import { qwen35RecordToAtifTrajectory } from './qwen-to-atif.js';
import { canonicalQwenFixture, canonicalQwenStressFixture } from './roundtrip-fixtures.js';

describe('qwen35RecordToAtifTrajectory', () => {
  it('projects a Qwen35 record into canonical ATIF and preserves an exact Qwen snapshot', () => {
    const record = canonicalQwenFixture();
    const trajectory = qwen35RecordToAtifTrajectory(record);
    const roundtrip = trajectory.extra as { roundtrip?: { qwen35_record_json?: string } } | undefined;

    expect(trajectory.session_id).toBe(record.request_id);
    expect(trajectory.steps.map((step) => step.source)).toEqual(['system', 'user', 'agent', 'agent']);
    expect(trajectory.steps[2]?.tool_calls?.[0]?.tool_call_id).toBe('tool_call_3_1');
    expect(trajectory.steps[2]?.observation?.results?.[0]?.content).toBe('done <video-1>');
    expect(roundtrip?.roundtrip?.qwen35_record_json).toBe(JSON.stringify(record));
  });

  it('round-trips Qwen35 records exactly through ATIF', () => {
    const record = canonicalQwenFixture();
    const restored = atifTrajectoryToQwen35Record(qwen35RecordToAtifTrajectory(record));
    expect(restored).toEqual(record);
  });

  it('round-trips a Qwen stress fixture with multiple tool calls and empty assistant content', () => {
    const record = canonicalQwenStressFixture();
    const trajectory = qwen35RecordToAtifTrajectory(record);

    expect(trajectory.steps.map((step) => step.source)).toEqual(['system', 'user', 'agent', 'user', 'agent']);
    expect(trajectory.steps[2]?.tool_calls?.map((toolCall) => toolCall.tool_call_id)).toEqual(['call_a', 'call_b']);
    expect(trajectory.steps[2]?.message).toBe('');
    expect(atifTrajectoryToQwen35Record(trajectory)).toEqual(record);
  });
});
