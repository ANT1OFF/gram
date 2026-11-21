import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** What the rule reads from the file system. */
export interface ExecFs {
  exists(path: string): boolean;
  /** The path with every link resolved; throws when it can't be. */
  realpath(path: string): string;
}

export const nodeExecFs: ExecFs = { exists: existsSync, realpath: (path) => realpathSync(path) };

/**
 * `fromMount: false` when this process doesn't run from an AppImage mount (whatever `$APPIMAGE`
 * says); otherwise `fromMount: true` with the AppImage file, or undefined when `$APPIMAGE` names
 * nothing usable. Both paths are compared resolved, since the runtime builds `$APPDIR` from
 * `$TMPDIR` as given (a trailing `/`, a linked `/home`) while `execPath` is real.
 */
export function appImageOrigin(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
  fs: ExecFs = nodeExecFs,
): { readonly fromMount: false } | { readonly fromMount: true; readonly appImage?: string } {
  const real = (path: string) => {
    try {
      return fs.realpath(path);
    } catch {
      return resolve(path);
    }
  };
  const appDir = env["APPDIR"];
  if (!appDir || !isAbsolute(appDir)) return { fromMount: false };
  const mount = real(appDir);
  if (mount === dirname(mount)) return { fromMount: false };
  const inside = relative(mount, real(execPath));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return { fromMount: false };
  const appImage = env["APPIMAGE"];
  return appImage && isAbsolute(appImage) && fs.exists(appImage)
    ? { fromMount: true, appImage }
    : { fromMount: true };
}
