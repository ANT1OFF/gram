import type { FolderAccessDenial } from "@gram/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { errorMessage, isNotImplemented } from "@/api/errors";
import { folderAccessDenial } from "@/api/folder-access";

type FolderProblemKind =
  | "notFound"
  | "notADirectory"
  | "permissionDenied"
  | "unavailable"
  | "other";

export interface FolderProblem {
  kind: FolderProblemKind;
  message: string;
  /** The server's typed denial, when the OS refused the read; the picker offers recovery. */
  access?: FolderAccessDenial;
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const decodeNotFound = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.Literal("NotFound"),
    entity: Schema.optional(Schema.Unknown),
    id: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.Unknown),
  }),
);

/**
 * A rejected `fs.browse` or `thread.create` for a folder, in the user's terms. The server's own
 * message wins; a `NotFound` project without one becomes "Folder not found: <path>".
 */
export function folderProblem(error: unknown): FolderProblem {
  if (isNotImplemented(error)) {
    return { kind: "unavailable", message: "Folder browsing isn't available yet" };
  }
  const notFound = Option.getOrUndefined(decodeNotFound(error));
  if (notFound !== undefined && (stringOf(notFound.entity) ?? "project") === "project") {
    const id = stringOf(notFound.id);
    const fallback = id ? `Folder not found: ${id}` : "Folder not found";
    return { kind: "notFound", message: stringOf(notFound.message) || fallback };
  }
  const text = errorMessage(error);
  const access = folderAccessDenial(error);
  if (access !== undefined) return { kind: "permissionDenied", message: text, access };
  if (/Files & Folders|permission denied|EACCES|EPERM/i.test(text)) {
    return { kind: "permissionDenied", message: text };
  }
  if (/not a git repository/i.test(text)) {
    return {
      kind: "other",
      message:
        "This folder isn't a git repository, so it can't get a worktree. Use Current checkout, or run git init first.",
    };
  }
  if (/not a (folder|directory)|ENOTDIR/i.test(text)) {
    return { kind: "notADirectory", message: text };
  }
  return { kind: "other", message: text };
}
