/** Saved session files start with their creation time, such as `2026-10-24T05-00-00-000Z_<id>.jsonl`. */
export function startedAtFromPath(path: string | undefined): number | undefined {
  const name = path?.split('/').at(-1) ?? '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : undefined;
}
