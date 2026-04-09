import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPiRecords } from './pi.js';

describe('collectPiRecords no-user branches', () => {
  it('skips leaf branches that do not contain any user message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-no-user-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/project' }),
        JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', provider: 'test', modelId: 'model' }),
        JSON.stringify({ type: 'branch_summary', id: 'b1', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', fromId: 'x', summary: 'summary only branch' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const records = await collectPiRecords(dir);
    expect(records).toHaveLength(0);
  });
});
