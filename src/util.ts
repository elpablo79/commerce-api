const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

/** Escapes LIKE wildcards so user input is matched literally. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
