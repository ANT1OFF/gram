import { describe, expect, it } from "vitest";
import { macArtifactName, sourceFailure, type MacArtifactMethod } from "./mac-artifacts.ts";

describe("macOS release artifact names", () => {
  it("names each method's ZIP and requires an explicit method", () => {
    expect(macArtifactName("1.1.0", "signed-native-macos-v1")).toBe(
      "gram_1.1.0_darwin-arm64_signed.zip",
    );
    expect(macArtifactName("1.1.0", "unsigned-private-helper")).toBe(
      "gram_1.1.0_darwin-arm64_unsigned.zip",
    );
    expect(() => macArtifactName("1.1.0", undefined as unknown as MacArtifactMethod)).toThrow(
      "explicit",
    );
  });
});

describe("why gh couldn't read releases", () => {
  it.each([
    [null, "spawn gh ENOENT", "Install GitHub CLI (gh) to check private releases."],
    [1, "HTTP 401: Bad credentials", "Sign in with gh auth login for github.com"],
    [
      1,
      "HTTP 404: Not Found",
      "Your gh account cannot access example/gram or this release is no longer available.",
    ],
    [1, "HTTP 429: rate limit exceeded", "GitHub rate limit reached."],
    [1, "something else", "GitHub update check failed."],
  ] as const)("exit %s with %j", (status, stderr, message) => {
    expect(sourceFailure(status, stderr, "example/gram").message).toContain(message);
  });
});
