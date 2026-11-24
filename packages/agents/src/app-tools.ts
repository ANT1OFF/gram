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
