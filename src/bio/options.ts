/**
 * Merging caller options over defaults.
 *
 * Plain object spread lets an explicitly-undefined property erase a default — a trap when
 * options come from an API request where every optional field is present but undefined.
 * `withDefaults` ignores undefined values, which is what callers always mean.
 */
export function withDefaults<T extends object>(defaults: T, overrides?: Partial<T> | null): T {
  const result = { ...defaults };
  if (!overrides) return result;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}
