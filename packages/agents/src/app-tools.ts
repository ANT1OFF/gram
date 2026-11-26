import type { AppToolClass } from "@gram/contracts";
import * as Predicate from "effect/Predicate";

/** The MCP server name each thread's app tools are registered under, in every agent's config. */
export const APP_TOOLS_SERVER_NAME = "gram";

/** One part of a tool result that is more than text: an image beside it, as a screenshot's. */
export type AppToolPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** An app tool's output as MCP content parts, rather than one text the transports would stringify. */
export interface AppToolContent {
  readonly _tag: "AppToolContent";
  readonly parts: ReadonlyArray<AppToolPart>;
}

export const appToolContent = (parts: ReadonlyArray<AppToolPart>): AppToolContent => ({
  _tag: "AppToolContent",
  parts,
});

/**
 * An app tool's output as an MCP result's content, for every transport alike: its parts when it
 * returned `AppToolContent`, else one text part, the output itself when a string, else its JSON.
 */
const isAppToolContent = (output: unknown): output is AppToolContent =>
  Predicate.isObject(output) &&
  output["_tag"] === "AppToolContent" &&
  Array.isArray(output["parts"]);

export const appToolResultContent = (output: unknown): AppToolPart[] =>
  isAppToolContent(output)
    ? [...output.parts]
    : [
        {
          type: "text",
          text: typeof output === "string" ? output : JSON.stringify(output ?? null),
        },
      ];

/** MCP tool annotations, as the `gram` server lists a tool. */
export interface AppToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * What an app tool's safety class tells an agent about it, as MCP tool annotations, so an agent
 * can run reads side by side and skip its own prompt for them, and warn before what reaches
 * outside. A *read* changes nothing; *outward* acts past the app. The rest is left to MCP's
 * defaults (a write may destroy, and may reach outside), since a class doesn't say: a read can
 * still bring in a web page or a review comment, and a *self* tool can delete a note. Hints only:
 * the registry's gate decides every call.
 */
export const appToolAnnotations = (toolClass: AppToolClass): AppToolAnnotations =>
  toolClass === "read"
    ? { readOnlyHint: true }
    : toolClass === "outward" || toolClass === "outwardGated"
      ? { readOnlyHint: false, openWorldHint: true }
      : { readOnlyHint: false };

const NON_FINITE = ["Infinity", "-Infinity", "NaN"];

const isNonFiniteAlternative = (branch: unknown): boolean => {
  if (!Predicate.isObject(branch) || branch["type"] !== "string") return false;
  const words: unknown = branch["enum"];
  return (
    Array.isArray(words) &&
    words.length === NON_FINITE.length &&
    NON_FINITE.every((word) => words.includes(word))
  );
};

/**
 * An app tool's input JSON Schema as a session lists it, without what Effect's JSON Schema adds and
 * a tool's `run` never takes: the `"Infinity"`, `"-Infinity"` and `"NaN"` strings beside a number
 * (run decodes numbers only), an integer's safe-integer bounds (run enforces them), and
 * `additionalProperties: true`, which is JSON Schema's default (zod's `fromJSONSchema` too).
 */
export const listedInputSchema = (
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = listedValue(value);
  const anyOf = out["anyOf"];
  if (
    Array.isArray(anyOf) &&
    anyOf.length === 2 &&
    Predicate.isObject(anyOf[0]) &&
    anyOf[0]["type"] === "number" &&
    Object.keys(anyOf[0]).length === 1 &&
    isNonFiniteAlternative(anyOf[1])
  ) {
    delete out["anyOf"];
    out["type"] = "number";
  }
  if (
    out["type"] === "integer" &&
    out["minimum"] === Number.MIN_SAFE_INTEGER &&
    out["maximum"] === Number.MAX_SAFE_INTEGER
  ) {
    delete out["minimum"];
    delete out["maximum"];
  }
  if (out["additionalProperties"] === true) delete out["additionalProperties"];
  return out;
};

const listedValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(listedValue)
    : Predicate.isObject(value)
      ? listedInputSchema(value)
      : value;
