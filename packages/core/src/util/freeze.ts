/** Freeze `v` and everything below it (also below an already-frozen object). */
export function deepFreeze<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v;
  Object.freeze(v);
  for (const child of Object.values(v)) {
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) deepFreeze(child);
  }
  return v;
}
