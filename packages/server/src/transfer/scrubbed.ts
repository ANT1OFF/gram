import { redactSecrets, redactText } from "../logging/redact.ts";

const TOOL_PAYLOAD: ReadonlySet<string> = new Set(["input", "output", "rawInput", "result"]);

const scrub = (value: unknown, tools: boolean): unknown => {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((each: unknown) => scrub(each, tools));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        scrub(tools && TOOL_PAYLOAD.has(key) ? redactSecrets(inner) : inner, tools),
      ]),
    );
  }
  return value;
};

/**
 * `value` with every string in it scrubbed of what looks like a credential. With `tools`, for
 * messages, what a tool was given or answered is also censored by key, as the transcript archive
 * does it, since `{"password": …}` holds its secret in a string that looks like nothing.
 */
export const scrubbed = <A>(value: A, tools = false): A =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scrub rewrites only strings, and the secret-named fields of tool payloads, which are untyped
  scrub(value, tools) as A;
