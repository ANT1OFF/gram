import * as Schema from "effect/Schema";

/**
 * The operating system refused to let the server read a folder or file (on macOS, usually a missing
 * Files & Folders grant). Carried on `InvalidState.access`, so clients offer recovery without
 * reading the message.
 */
export const FolderAccessDenial = Schema.Struct({
  path: Schema.String,
  code: Schema.Literals(["EACCES", "EPERM"]),
});
export type FolderAccessDenial = typeof FolderAccessDenial.Type;
