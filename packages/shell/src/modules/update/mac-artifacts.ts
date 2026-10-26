/** How a macOS release ZIP was built: the release tooling still produces unsigned ones. */
export type MacArtifactMethod = "unsigned-private-helper" | "signed-native-macos-v1";
function assertMacArtifactMethod(method: MacArtifactMethod): void {
  if (method !== "unsigned-private-helper" && method !== "signed-native-macos-v1")
    throw new Error("An explicit Mac artifact method is required");
}
export function macArtifactName(version: string, method: MacArtifactMethod): string {
  assertMacArtifactMethod(method);
  return `gram_${version}_darwin-arm64_${method === "unsigned-private-helper" ? "unsigned" : "signed"}.zip`;
}

export class SourceError extends Error {}
/** Why `gh` couldn't read `repo`'s releases, for the user; `repo` is the one it was asked about. */
export const sourceFailure = (status: number | null, stderr: string, repo: string): SourceError =>
  new SourceError(
    status === null && /ENOENT|not found/i.test(stderr)
      ? "Install GitHub CLI (gh) to check private releases."
      : /401|not logged|authentication|auth login/i.test(stderr)
        ? "Sign in with gh auth login for github.com to check private releases."
        : /403|404|not found|forbidden/i.test(stderr)
          ? `Your gh account cannot access ${repo} or this release is no longer available.`
          : /429|rate limit/i.test(stderr)
            ? "GitHub rate limit reached. Try again later."
            : "GitHub update check failed. Check your network and gh access, then try again.",
  );
