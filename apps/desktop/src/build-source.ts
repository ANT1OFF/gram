import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Build-time only. Never guess a source revision for a modified or unversioned checkout. */
export function captureBuildSource(root: string): string | null {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    // Git walks ancestors: an archive inside an ignored directory is not that parent source.
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(root)) return null;
    if (git(["status", "--porcelain", "--untracked-files=normal"])) return null;
    const source = git(["rev-parse", "HEAD"]);
    return /^[a-f0-9]{40}$/.test(source) ? source : null;
  } catch {
    return null;
  }
}
