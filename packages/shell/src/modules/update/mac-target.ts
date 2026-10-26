import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sha256 } from "./mac-bundle.ts";
import { macFs, macFsPromises } from "./mac-fs.ts";

/** The only places a Gram on this Mac may be replaced in place by an update. */
export const personalMacTargets = () => [
  "/Applications/Gram.app",
  join(homedir(), "Applications/Gram.app"),
];

/** A user-owned bundle whose plist and executable can be read. */
async function ownedBundle(path: string): Promise<void> {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.())
    throw new Error("The Gram bundle must be owned by this user.");
  await sha256(join(path, "Contents/Info.plist"));
  await sha256(join(path, "Contents/MacOS/Gram"));
}

/**
 * Whether `destination`, the running executable's own bundle, may be replaced without elevation:
 * one of `allowed` at its canonical path, owned by this user, in a parent that is this user's (or
 * root's `/Applications`), not world-writable and writable by this user. No renderer path.
 */
export async function writableMacTarget(
  destination: string,
  allowed = personalMacTargets(),
): Promise<boolean> {
  try {
    if (
      !allowed.includes(destination) ||
      (await realpath(destination)) !== destination ||
      (await realpath(dirname(destination))) !== dirname(destination)
    )
      return false;
    const parent = await lstat(dirname(destination));
    if (
      !parent.isDirectory() ||
      (parent.uid !== process.getuid?.() &&
        !(dirname(destination) === "/Applications" && parent.uid === 0)) ||
      (parent.mode & 0o002) !== 0
    )
      return false;
    await ownedBundle(destination);
    await access(dirname(destination), constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const { constants } = macFs;
const { access, lstat, realpath } = macFsPromises;
