export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeJson(item)]);
    return Object.fromEntries(entries);
  }

  return value;
}

export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function parseCanonicalJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
