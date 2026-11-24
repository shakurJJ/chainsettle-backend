/**
 * Field-level diffs for shipment audit entries (#436).
 *
 * Updates store `metadata.changes = [{ field, before, after }]` on the audit
 * log, containing only the fields that actually changed. Nested `metadata`
 * JSON is flattened to dot-path keys (`metadata.port.origin`) so each leaf
 * change is reported on its own; arrays are compared as whole values.
 */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flattens nested objects into `{ 'a.b.c': leaf }`; arrays are leaves. */
export function flattenToDotPaths(value: unknown, prefix: string): Record<string, unknown> {
  if (!isPlainObject(value)) return { [prefix]: value };
  const keys = Object.keys(value);
  if (keys.length === 0) return { [prefix]: {} };
  const out: Record<string, unknown> = {};
  for (const key of keys) Object.assign(out, flattenToDotPaths(value[key], `${prefix}.${key}`));
  return out;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/**
 * Computes changes for the given top-level fields. Objects are compared
 * leaf-by-leaf via dot paths; missing values are reported as `null`.
 */
export function computeFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const b = before[field] ?? null;
    const a = after[field] ?? null;
    if (isPlainObject(b) || isPlainObject(a)) {
      const fb = isPlainObject(b) ? flattenToDotPaths(b, field) : { [field]: b };
      const fa = isPlainObject(a) ? flattenToDotPaths(a, field) : { [field]: a };
      const paths = Array.from(new Set([...Object.keys(fb), ...Object.keys(fa)])).sort();
      for (const path of paths) {
        const pb = fb[path] ?? null;
        const pa = fa[path] ?? null;
        if (!same(pb, pa)) changes.push({ field: path, before: pb, after: pa });
      }
    } else if (!same(b, a)) {
      changes.push({ field, before: b, after: a });
    }
  }
  return changes;
}

/**
 * Non-admins can't see "private" metadata keys: any path segment starting
 * with `_` or named `internal` (e.g. `metadata.internal.cost`, `metadata._note`).
 */
export function isHiddenField(field: string): boolean {
  return field
    .split('.')
    .slice(1)
    .some((seg) => seg.startsWith('_') || seg.toLowerCase() === 'internal');
}

/** Reads stored changes from an audit entry; older entries yield []. */
export function extractChanges(auditMetadata: unknown): FieldChange[] {
  if (!isPlainObject(auditMetadata)) return [];
  const raw = auditMetadata.changes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is FieldChange => isPlainObject(c) && typeof c.field === 'string')
    .map((c) => ({ field: c.field, before: c.before ?? null, after: c.after ?? null }));
}
