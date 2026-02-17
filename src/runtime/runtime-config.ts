type PlainObject = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const deepMerge = <T>(base: T, override: unknown): T => {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(base) || Array.isArray(override)) {
    return override as T;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result: PlainObject = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = deepMerge((base as PlainObject)[key], value);
    }
    return result as T;
  }

  return override as T;
};

export const getAtPath = (obj: unknown, path: string[]): unknown => {
  let current: unknown = obj;
  for (const part of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
};

export const setAtPath = (obj: PlainObject, path: string[], value: unknown): void => {
  if (path.length === 0) {
    throw new Error('Path cannot be empty');
  }

  let current: PlainObject = obj;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part] as PlainObject;
  }
  current[path[path.length - 1]] = value;
};

export const unsetAtPath = (obj: PlainObject, path: string[]): void => {
  if (path.length === 0) {
    return;
  }

  let current: PlainObject = obj;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!isPlainObject(next)) {
      return;
    }
    current = next;
  }
  delete current[path[path.length - 1]];
};

export const parseUserValue = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }

  // JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as unknown;
  }

  // number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }

  // quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

export const redactSecrets = <T>(value: T, secretPaths: string[][]): T => {
  const clone = (globalThis as unknown as { structuredClone?: <V>(input: V) => V }).structuredClone
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);

  for (const path of secretPaths) {
    if (path.length === 0) {
      continue;
    }

    let current: unknown = clone;
    for (const part of path.slice(0, -1)) {
      if (!isPlainObject(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }

    if (isPlainObject(current)) {
      const last = path[path.length - 1];
      if (last in current && typeof current[last] === 'string' && current[last] !== '') {
        current[last] = '***';
      }
    }
  }

  return clone;
};

