// Where an agent's browser evidence (a PNG screenshot, a GIF recording) is written: inside its own
// thread's checkout only, so a page capture lands in the thread's own work and never over a file
// outside the work the thread owns, through `..` or a symbolic link.

import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { isStrictlyInside, realPath } from "@gram/git";

/** Why a path can't take evidence; the message the tool returns. */
export class EvidencePathError extends Error {}

/**
 * Writes `bytes` at `requested`, relative to `root` (the thread's checkout) or absolute inside it,
 * which must end in `extension`. Parent folders are made. Refuses a path outside the checkout, one
 * whose existing folders lead out of it through a link, and a link at the file itself. Returns
 * the absolute path written.
 */
export async function writeEvidence(
  root: string,
  requested: string,
  bytes: Uint8Array,
  extension: ".png" | ".gif",
): Promise<string> {
  const trimmed = requested.trim();
  if (!trimmed.toLowerCase().endsWith(extension))
    throw new EvidencePathError(`The path must end in ${extension}.`);
  const realRoot = await realPath(root).catch(() => {
    throw new EvidencePathError("The thread's folder isn't there.");
  });
  // An absolute path spelled through the checkout's own name (`/tmp` for `/private/tmp`) counts.
  const spelled = resolve(root, trimmed);
  const target = isStrictlyInside(resolve(root), spelled)
    ? resolve(realRoot, relative(resolve(root), spelled))
    : resolve(realRoot, trimmed);
  if (!isStrictlyInside(realRoot, target))
    throw new EvidencePathError("Evidence is written inside the thread's folder only.");
  // The nearest folder that exists already must be inside too, links resolved, before any is made.
  let existing = dirname(target);
  for (;;) {
    const info = await lstat(existing).catch(() => undefined);
    if (info !== undefined) break;
    const up = dirname(existing);
    if (up === existing) break;
    existing = up;
  }
  const realExisting = await realPath(existing);
  if (realExisting !== realRoot && !isStrictlyInside(realRoot, realExisting))
    throw new EvidencePathError("That folder leads outside the thread's folder.");
  await mkdir(dirname(target), { recursive: true });
  const realParent = await realPath(dirname(target));
  if (realParent !== realRoot && !isStrictlyInside(realRoot, realParent))
    throw new EvidencePathError("That folder leads outside the thread's folder.");
  const final = `${realParent}${sep}${target.slice(dirname(target).length + 1)}`;
  // Opened without following a link swapped in since, and refused when the file is also linked
  // from elsewhere, which would write through to a file outside; truncated only once checked.
  const file = await open(
    final,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o644,
  ).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP" || error.code === "EISDIR"
      ? new EvidencePathError("Something other than a file is at that path.")
      : error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new EvidencePathError("Something other than a file is at that path.");
    if (info.nlink > 1)
      throw new EvidencePathError("That file is linked from elsewhere, so it isn't overwritten.");
    await file.truncate(0);
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return final;
}
