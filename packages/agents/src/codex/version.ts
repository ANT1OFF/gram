/**
 * The Codex CLI version `protocol/` was generated from (`scripts/codex-protocol.mjs`). A different
 * installed CLI gets a skew warning.
 */
export const CODEX_CLI_VERSION = "0.166.0";

// Semver identifiers reject leading zeroes on numeric components, including prereleases.
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(
  `^(${numeric})\\.(${numeric})\\.(${numeric})(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/** Semver precedence against one of Gram's stable Codex pins; NaN for an unreadable version. */
export const compareCodexVersion = (
  version: string | undefined,
  pin = CODEX_CLI_VERSION,
): number => {
  const parsed = version === undefined ? null : semver.exec(version);
  if (parsed === null) return Number.NaN;
  const core = parsed.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return Number.NaN;
  const baseline = pin.split(".").map(Number);
  const difference = core[0]! - baseline[0]! || core[1]! - baseline[1]! || core[2]! - baseline[2]!;
  return Math.sign(difference) || (parsed[4] === undefined ? 0 : -1);
};

/** Keep prerelease/build identifiers so version gates cannot mistake a preview for the pin. */
export const parseCodexCliVersion = (output: string): string | undefined => {
  const version = /\b\d+\.\d+\.\S+/.exec(output)?.[0];
  return Number.isNaN(compareCodexVersion(version)) ? undefined : version;
};

export const codexVersionWarning = (
  cliVersion: string,
  pin = CODEX_CLI_VERSION,
): string | undefined => {
  if (compareCodexVersion(cliVersion, pin) === 0) return undefined;
  return `Codex ${cliVersion} differs from ${pin}, which Gram's Codex adapter is built for; some features may misbehave.`;
};
