import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  QWEN_PLAIN_TEXT_CODEC_VERSION,
  QWEN_PLAIN_TEXT_METADATA_BEGIN,
  QWEN_PLAIN_TEXT_METADATA_END,
} from '../roundtrip.js';
import { Qwen35RecordSchema } from './qwen35.js';
import { parseCanonicalJson, toCanonicalJson } from '../utils/canonical-json.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export const Qwen35PlainTextMetadataSchema = z.object({
  codec_version: z.literal(QWEN_PLAIN_TEXT_CODEC_VERSION),
  body_sha256: z.string().regex(SHA256_HEX_RE),
  qwen_record_json: z.string(),
}).superRefine((metadata, ctx) => {
  try {
    Qwen35RecordSchema.parse(parseCanonicalJson(metadata.qwen_record_json));
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `qwen_record_json must contain a valid Qwen35Record: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

export const Qwen35PlainTextArtifactSchema = z.object({
  body: z.string(),
  metadata: Qwen35PlainTextMetadataSchema,
  text: z.string(),
}).superRefine((artifact, ctx) => {
  if (artifact.metadata.body_sha256 !== sha256(artifact.body)) {
    ctx.addIssue({ code: 'custom', message: 'metadata.body_sha256 must match the plaintext body' });
  }

  const expectedText = composeQwen35PlainText(artifact.body, artifact.metadata);
  if (artifact.text !== expectedText) {
    ctx.addIssue({ code: 'custom', message: 'text must equal the canonical body plus metadata trailer' });
  }
});

export const Qwen35PlainTextSchema = z.string().superRefine((value, ctx) => {
  try {
    parseQwen35PlainTextArtifact(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export type Qwen35PlainTextMetadata = z.infer<typeof Qwen35PlainTextMetadataSchema>;
export type Qwen35PlainTextArtifact = z.infer<typeof Qwen35PlainTextArtifactSchema>;
export type Qwen35PlainText = z.infer<typeof Qwen35PlainTextSchema>;

export function parseQwen35PlainTextArtifact(input: string): Qwen35PlainTextArtifact {
  const { body, metadataText } = splitQwen35PlainText(input);
  const metadata = Qwen35PlainTextMetadataSchema.parse(parseCanonicalJson(metadataText));
  return Qwen35PlainTextArtifactSchema.parse({ body, metadata, text: input });
}

export function composeQwen35PlainText(body: string, metadata: Qwen35PlainTextMetadata): string {
  return `${body}\n${QWEN_PLAIN_TEXT_METADATA_BEGIN}\n${toCanonicalJson(metadata)}\n${QWEN_PLAIN_TEXT_METADATA_END}\n`;
}

function splitQwen35PlainText(input: string): { body: string; metadataText: string } {
  const beginIndex = input.indexOf(QWEN_PLAIN_TEXT_METADATA_BEGIN);
  const endIndex = input.indexOf(QWEN_PLAIN_TEXT_METADATA_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error('missing plaintext metadata trailer');
  }

  const body = input.slice(0, beginIndex).replace(/\n$/, '');
  const metadataStart = beginIndex + QWEN_PLAIN_TEXT_METADATA_BEGIN.length;
  const metadataText = input.slice(metadataStart, endIndex).trim();
  return { body, metadataText };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
