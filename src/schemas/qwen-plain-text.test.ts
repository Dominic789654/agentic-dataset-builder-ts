import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalQwenStressFixture } from '../roundtrip-fixtures.js';
import { qwen35RecordToPlainText } from '../qwen-plain-text.js';
import {
  parseQwen35PlainTextArtifact,
  Qwen35PlainTextArtifactSchema,
  Qwen35PlainTextSchema,
} from './qwen-plain-text.js';

const qwenPlainTextSchemaJson = JSON.parse(
  fs.readFileSync(path.resolve('schemas/qwen_plain_text.schema.json'), 'utf8'),
) as Record<string, any>;

describe('Qwen35PlainText schemas', () => {
  it('accepts a canonical plaintext artifact', () => {
    const text = qwen35RecordToPlainText(canonicalQwenStressFixture());
    const artifact = parseQwen35PlainTextArtifact(text);

    expect(Qwen35PlainTextSchema.parse(text)).toBe(text);
    expect(Qwen35PlainTextArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.metadata.codec_version).toBe('agentic-dataset-builder/qwen-plain-text-v1');
  });

  it('rejects plaintext without the metadata trailer', () => {
    expect(() => Qwen35PlainTextSchema.parse('plain body only')).toThrow('missing plaintext metadata trailer');
  });

  it('ships a JSON schema with the expected top-level fields', () => {
    expect(qwenPlainTextSchemaJson.title).toBe('Qwen Plain Text Artifact');
    expect(qwenPlainTextSchemaJson.type).toBe('object');
    expect(qwenPlainTextSchemaJson.required).toEqual(['body', 'metadata', 'text']);
    expect((qwenPlainTextSchemaJson.$defs as Record<string, unknown>).PlainTextMetadata).toBeDefined();
    expect((qwenPlainTextSchemaJson.$defs as Record<string, unknown>).PlainText).toBeDefined();
  });
});
