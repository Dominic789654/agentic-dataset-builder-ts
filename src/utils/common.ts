import fs from 'node:fs';
import path from 'node:path';

export function compactText(value: string, limit = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export function timestampDir(prefix: string): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${prefix}-${stamp}`;
}

export function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function walkObject(value: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObject(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    visit(obj);
    for (const child of Object.values(obj)) walkObject(child, visit);
  }
}

export function resolveChildren(base: string, ...parts: string[]): string {
  return path.resolve(base, ...parts);
}
