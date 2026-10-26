import { homedir } from "node:os";
import { join } from "node:path";

interface DataDirEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string | undefined;
}

/** Preserve the base's separators when computing paths for a different platform in tests. */
const joinDataPath = (base: string, ...parts: readonly string[]): string => {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
};

/** Conventional per-user application data root, with a usable fallback when no home is known. */
export const osDataRoot = ({ env, platform, homeDir }: DataDirEnv): string => {
  if (platform === "darwin") {
    if (homeDir !== undefined) return joinDataPath(homeDir, "Library", "Application Support");
  } else if (platform === "win32") {
    if (env["APPDATA"]) return env["APPDATA"];
  } else {
    if (env["XDG_DATA_HOME"]) return env["XDG_DATA_HOME"];
    if (homeDir !== undefined) return joinDataPath(homeDir, ".local", "share");
  }
  return homeDir ?? ".";
};

/** `<OS data root>/gram-state`, unless `GRAM_DATA_DIR` overrides it. */
export const defaultDataDir = (env: Record<string, string | undefined> = process.env): string =>
  env["GRAM_DATA_DIR"] ??
  join(
    osDataRoot({ env, platform: process.platform, homeDir: homedir() || undefined }),
    "gram-state",
  );
