/**
 * The own enumerable fields of a value of unknown shape (parsed JSON, an IPC or postMessage
 * payload), for reading fields whose names are only known at run time. Each value is `unknown`:
 * check it before use. Anything that isn't an object has no fields.
 */
export const fieldsOf = (value: unknown): ReadonlyMap<string, unknown> =>
  new Map<string, unknown>(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );

/** The `code` a Node system error carries (`ENOENT`, `EEXIST`, …); undefined for anything else. */
export const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
