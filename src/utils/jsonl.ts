import fs from 'node:fs';
import readline from 'node:readline';

export async function readJsonl(filePath: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

export async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.promises.writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
    'utf8',
  );
}
