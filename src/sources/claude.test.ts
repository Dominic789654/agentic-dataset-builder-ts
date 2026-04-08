import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectClaudePromptOnlyRecords } from './claude.js';

describe('collectClaudePromptOnlyRecords', () => {
  it('extracts user prompts from Claude project jsonl', async () => {
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
});
