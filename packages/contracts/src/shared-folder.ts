import * as Schema from "effect/Schema";

/**
 * A workspace's shared folder: plain files every thread in the workspace reads and writes, kept with
 * Gram's own data and mirrored to each other machine a thread of the workspace runs on. Unlike
 * workspace memory it has no curator: the last write wins.
 */

/** The largest file the shared folder carries between machines. A larger one stays where it is. */
export const SHARED_FILE_MAX_BYTES = 64 * 2 ** 20;
/** The most files one workspace's shared folder carries between machines. */
export const SHARED_FILES_MAX = 5_000;
/** The most bytes one `host.shared.read` or `host.shared.write` carries. */
export const SHARED_PART_BYTES = 4 * 2 ** 20;
/** What names Gram's own files in a shared folder: never listed, carried or shown. */
export const SHARED_RESERVED_PREFIX = ".gram-";

/** One file in a shared folder, by its path inside it with `/` between parts. */
export const SharedEntry = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  mtimeMs: Schema.Number,
  sha256: Schema.String,
});
export type SharedEntry = typeof SharedEntry.Type;

/**
 * A shared folder's files. `held` names files that are there but not carried (too large), which a
 * sync leaves alone on both sides. `complete` is false when the listing stopped early (too many
 * files): a file it doesn't name may still be there, so nothing is taken as deleted from it.
 */
export const SharedListing = Schema.Struct({
  entries: Schema.Array(SharedEntry),
  held: Schema.Array(Schema.String),
  complete: Schema.Boolean,
});
export type SharedListing = typeof SharedListing.Type;

/** A part of a shared file, as base64, and the file's whole size and hash when it was read. */
export const SharedPart = Schema.Struct({
  data: Schema.String,
  size: Schema.Int,
  sha256: Schema.String,
});
export type SharedPart = typeof SharedPart.Type;

/** A `sha256` that says the file must not be there. */
export const SHARED_ABSENT = "absent";

// Control characters, and the characters Windows refuses in a name.
// oxlint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

/**
 * Whether `path` may name a file in a shared folder: relative, `/` between parts, no empty, `.` or
 * `..` part, no part Gram keeps for itself, nothing a file system on another machine can't hold.
 */
export const isSharedPath = (path: string): boolean => {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/")) return false;
  if (UNSAFE_CHARACTERS.test(path)) return false;
  const parts = path.split("/");
  return parts.every(
    (part) =>
      part.length > 0 &&
      part.length <= 255 &&
      part !== "." &&
      part !== ".." &&
      !part.startsWith(SHARED_RESERVED_PREFIX) &&
      !part.endsWith(" ") &&
      !part.endsWith("."),
  );
};

/** The workspace ids a shared folder is kept for: what a folder name can hold everywhere. */
export const isSharedWorkspaceId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);
