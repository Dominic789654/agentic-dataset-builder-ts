import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from './jsonl.js';

describe('readJsonl', () => {
  it('skips malformed lines when skipInvalid is enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(file, '{"ok":1}\n{bad json}\n{"ok":2}\n', 'utf8');
    const rows = await readJsonl(file, { skipInvalid: true });
    expect(rows).toHaveLength(2);
  });

  it('throws with file and line info when skipInvalid is disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const file = path.join(dir, 'sample.jsonl');
    fs.writeFileSync(file, '{bad json}\n', 'utf8');
    await expect(readJsonl(file)).rejects.toThrow(/sample\.jsonl:1:/);
  });
});
