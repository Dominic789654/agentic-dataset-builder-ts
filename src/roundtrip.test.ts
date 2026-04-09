import { describe, expect, it } from 'vitest';
import { atifTrajectoryToQwen35Record } from './atif-to-qwen.js';
import { plainTextToQwen35Record, qwen35RecordToPlainText } from './qwen-plain-text.js';
import { qwen35RecordToAtifTrajectory } from './qwen-to-atif.js';
import { canonicalAtifFixture, canonicalAtifStressFixture, canonicalQwenStressFixture } from './roundtrip-fixtures.js';

describe('ATIF/Qwen/plain-text round-trip chain', () => {
  it('round-trips ATIF exactly through Qwen35 records and plaintext', () => {
    const trajectory = canonicalAtifFixture();
    const plainText = qwen35RecordToPlainText(atifTrajectoryToQwen35Record(trajectory));
    const restoredTrajectory = qwen35RecordToAtifTrajectory(plainTextToQwen35Record(plainText));

    expect(restoredTrajectory).toEqual(trajectory);
    expect(qwen35RecordToPlainText(plainTextToQwen35Record(plainText))).toBe(plainText);
  });

  it('round-trips a stress ATIF fixture exactly through Qwen35 records and plaintext', () => {
    const trajectory = canonicalAtifStressFixture();
    const plainText = qwen35RecordToPlainText(atifTrajectoryToQwen35Record(trajectory));
    const restoredTrajectory = qwen35RecordToAtifTrajectory(plainTextToQwen35Record(plainText));

    expect(restoredTrajectory).toEqual(trajectory);
    expect(qwen35RecordToPlainText(plainTextToQwen35Record(plainText))).toBe(plainText);
  });

  it('round-trips a stress Qwen fixture exactly through ATIF and plaintext', () => {
    const record = canonicalQwenStressFixture();
    const atif = qwen35RecordToAtifTrajectory(record);
    const plainText = qwen35RecordToPlainText(record);

    expect(atifTrajectoryToQwen35Record(atif)).toEqual(record);
    expect(plainTextToQwen35Record(plainText)).toEqual(record);
    expect(qwen35RecordToPlainText(plainTextToQwen35Record(plainText))).toBe(plainText);
  });
});
