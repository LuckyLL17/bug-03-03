/**
 * Recursively freezes plain objects/arrays. Stored topology snapshots are
 * frozen immediately on publication, so later publications or callers cannot
 * mutate an already-released version's nodes, edges, or metadata.
 */
export function deepFreeze<T>(value:T):T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
