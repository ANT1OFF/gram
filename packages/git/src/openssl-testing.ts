import { spawnSync } from "node:child_process";

/**
 * For tests: a real OpenSSL 3, which checks a release's checksum signature as the installer does
 * on Linux. macOS's own `openssl` is LibreSSL, which can't, so on a Mac it is Homebrew's.
 */
export const openSsl3 = (): string => {
  const found = [
    spawnSync("sh", ["-c", "command -v openssl"], {
      encoding: "utf8",
    }).stdout.trim(),
    "/opt/homebrew/opt/openssl@3/bin/openssl",
    "/usr/local/opt/openssl@3/bin/openssl",
  ].find(
    (candidate) =>
      candidate !== "" &&
      /^OpenSSL [3-9]/.test(
        spawnSync(candidate, ["version"], { encoding: "utf8" }).stdout ?? "",
      ),
  );
  if (found === undefined)
    throw new Error(
      "These tests need OpenSSL 3 (on macOS: brew install openssl@3).",
    );
  return found;
};
