import { z } from 'zod';

export const PiSessionHeaderSchema = z.object({
  type: z.literal('session'),
  id: z.string(),
  timestamp: z.string(),
  cwd: z.string().optional(),
}).passthrough();

export const PiSessionEntrySchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  timestamp: z.string().optional(),
}).passthrough();

export const CodexEntrySchema = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ClaudeProjectEntrySchema = z.record(z.string(), z.unknown());

export type PiSessionHeader = z.infer<typeof PiSessionHeaderSchema>;
export type PiSessionEntry = z.infer<typeof PiSessionEntrySchema>;
export type CodexEntry = z.infer<typeof CodexEntrySchema>;
export type ClaudeProjectEntry = z.infer<typeof ClaudeProjectEntrySchema>;
