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
export const appToolResultContent = (output: unknown): AppToolPart[] =>
  typeof output === "object" &&
  output !== null &&
  (output as { _tag?: unknown })._tag === "AppToolContent"
    ? [...(output as AppToolContent).parts]
    : [
        {
          type: "text",
          text: typeof output === "string" ? output : JSON.stringify(output ?? null),
        },
      ];
