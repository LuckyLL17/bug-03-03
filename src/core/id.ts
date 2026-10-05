import { createHash, randomUUID } from 'node:crypto';
export const newId = (prefix:string) => `${prefix}_${randomUUID()}`;
/** Deterministic id for the same logical parts, so repeat analyses reproduce identical edge traces. */
export const stableId = (prefix:string, ...parts:Array<string|number>) =>
  `${prefix}_${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}`;
