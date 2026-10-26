import { spawnSync } from "node:child_process";

export const NOTARY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];

/** Report only a diagnosis, never notarytool's raw output or the history it returned. */
function diagnosis(output) {
  if (
    /keychain.*(?:locked|unavailable)|interaction.*not allowed|errSecInteractionNotAllowed|-25308/i.test(
      output,
    )
  )
    return "keychain locked or unavailable";
  // This message is ambiguous: a temporarily inaccessible keychain produces it too.
  if (/No Keychain password item found/i.test(output))
    return "keychain locked or unavailable, or profile missing (notarytool cannot distinguish)";
  if (/profile.*(?:not found|does not exist|missing)|no credentials.*profile/i.test(output))
    return "profile missing, or its keychain unavailable";
  return "notarytool could not access the profile or Apple service";
}

/** Names only; xcrun owns access to the keychain. Four bounded retries before refusing. */
export function preflightNotary({
  profile,
  env,
  say,
  xcrun = "/usr/bin/xcrun",
  backoff = NOTARY_BACKOFF_MS,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}) {
  let result;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    result = spawnSync(
      xcrun,
      ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"],
      { env, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 ** 2 },
    );
    if (result.status === 0) return true;
    if (attempt < backoff.length) {
      say(
        `  notary preflight attempt ${attempt + 1} failed; retrying in ${backoff[attempt] / 1000}s`,
      );
      wait(backoff[attempt]);
    }
  }
  return (
    `notarytool profile ${JSON.stringify(profile)} did not answer after ${backoff.length + 1} attempts: ` +
    `${diagnosis(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)}. ` +
    "Run xcrun notarytool history --keychain-profile <name> in a normal Terminal before re-creating anything."
  );
}
