import fs from 'node:fs';
import readline from 'node:readline';

export interface ReadJsonlOptions {
  skipInvalid?: boolean;
  onInvalidLine?: (info: { filePath: string; lineNumber: number; line: string; error: Error }) => void;
}

export async function readJsonl(filePath: string, options: ReadJsonlOptions = {}): Promise<unknown[]> {
  const rows: unknown[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!options.skipInvalid) {
        throw new SyntaxError(`${filePath}:${lineNumber}: ${err.message}`);
      }
      options.onInvalidLine?.({ filePath, lineNumber, line: trimmed, error: err });
    }
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
