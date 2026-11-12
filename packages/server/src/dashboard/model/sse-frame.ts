/** Pure SSE delta-frame encoder (kept dependency-free so it is unit-testable). */
/**
 * Encode one SSE frame for a client given what it last received. First frame
 * (empty `lastSent`) is the full payload; later frames are `{_delta:true,…}`
 * with only changed sections plus `_removed` keys. Mutates `lastSent`.
 */
export function encodeSseFrame(sections: Map<string, string>, lastSent: Map<string, string>): string {
  const full = lastSent.size === 0;
  const parts: string[] = [];
  for (const [k, json] of sections) {
    if (!full && lastSent.get(k) === json) continue;
    parts.push(JSON.stringify(k) + ':' + json);
    lastSent.set(k, json);
  }
  const removed: string[] = [];
  for (const k of [...lastSent.keys()]) {
    if (!sections.has(k)) { removed.push(k); lastSent.delete(k); }
  }
  if (full) return '{' + parts.join(',') + '}';
  if (removed.length) parts.push('"_removed":' + JSON.stringify(removed));
  return '{"_delta":true' + (parts.length ? ',' + parts.join(',') : '') + '}';
}
