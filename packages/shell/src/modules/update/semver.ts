/** A parsed semantic version (SemVer 2.0.0). */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifiers; numeric ones are numbers. Empty for a stable version. */
  readonly pre: readonly (string | number)[];
  readonly build: string;
}

const NUMERIC = "0|[1-9]\\d*";
const PRE_ID = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?` +
    `(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

/** Strict SemVer parse (no leading `v`, no leading zeros); null when `input` isn't one. */
export function parseVersion(input: string): Version | null {
  const m = SEMVER.exec(input);
  if (!m) return null;
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const pre =
    m[4] === undefined ? [] : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  if (pre.some((id) => typeof id === "number" && !Number.isSafeInteger(id))) return null;
  return { major, minor, patch, pre, build: m[5] ?? "" };
}

export function formatVersion(v: Version): string {
  const pre = v.pre.length > 0 ? `-${v.pre.join(".")}` : "";
  const build = v.build ? `+${v.build}` : "";
  return `${v.major}.${v.minor}.${v.patch}${pre}${build}`;
}

function compareIds(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Orders versions by SemVer precedence: a pre-release sorts below its release (`1.3.2-rc.2` <
 * `1.3.2`). Build metadata only breaks ties, as in Rust's `semver` crate, so the order is total.
 */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return Math.sign(core);
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length !== b.pre.length) return a.pre.length === 0 ? 1 : -1;
  } else {
    const pre = compareIds(a.pre, b.pre);
    if (pre !== 0) return Math.sign(pre);
  }
  if (a.build === b.build) return 0;
  return a.build < b.build ? -1 : 1;
}
