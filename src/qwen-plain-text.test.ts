import { describe, expect, it } from 'vitest';
import { QWEN_PLAIN_TEXT_METADATA_BEGIN } from './roundtrip.js';
import { plainTextToQwen35Record, qwen35RecordToPlainText } from './qwen-plain-text.js';
import { canonicalQwenFixture, canonicalQwenStressFixture } from './roundtrip-fixtures.js';

describe('Qwen35 plain-text codec', () => {
  it('renders canonical plaintext with a metadata trailer and round-trips exactly', () => {
    const record = canonicalQwenFixture();
    const plainText = qwen35RecordToPlainText(record);

    expect(plainText).toContain(QWEN_PLAIN_TEXT_METADATA_BEGIN);
    expect(plainText).toContain('<tool_call>');
    expect(plainText).toContain('<|vision_start|><|image_pad|><|vision_end|>');
    expect(plainText).toContain('<tool_response>');

    const restored = plainTextToQwen35Record(plainText);
    expect(restored).toEqual(record);
    expect(qwen35RecordToPlainText(restored)).toBe(plainText);
  });

  it('rejects tampered plaintext bodies', () => {
    const plainText = qwen35RecordToPlainText(canonicalQwenFixture());
    const tampered = plainText.replace('Inspect ', 'Inspect carefully ');
    expect(() => plainTextToQwen35Record(tampered)).toThrow('plain-text body hash mismatch');
  });

  it('round-trips a stress fixture with empty assistant content and multiple vision blocks', () => {
    const record = canonicalQwenStressFixture();
    const plainText = qwen35RecordToPlainText(record);

    expect(plainText).toContain('<tool_call>');
    expect(plainText).toContain('<|vision_start|><|image_pad|><|vision_end|>');
    expect(plainText).toContain('<|vision_start|><|video_pad|><|vision_end|>');

    const restored = plainTextToQwen35Record(plainText);
    expect(restored).toEqual(record);
    expect(qwen35RecordToPlainText(restored)).toBe(plainText);
  });
});
