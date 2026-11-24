import type { DesktopWindowInfo } from "@gram/contracts";

/** The renderer argument main uses to tell a window's preload who it is. */
export const WINDOW_ARG = "--gram-window=";

export const windowArg = (info: DesktopWindowInfo): string =>
  `${WINDOW_ARG}${encodeURIComponent(JSON.stringify(info))}`;

/** The window info in `argv`, or `undefined` (e.g. the smoke window, or anything malformed). */
export function parseWindowArg(argv: readonly string[]): DesktopWindowInfo | undefined {
  const arg = argv.find((entry) => entry.startsWith(WINDOW_ARG));
  if (arg === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(arg.slice(WINDOW_ARG.length)));
    if (typeof value !== "object" || value === null) return undefined;
    const id: unknown = "id" in value ? value.id : undefined;
    const name: unknown = "name" in value ? value.name : undefined;
    const primary: unknown = "primary" in value ? value.primary : undefined;
    const initialThreadId: unknown = "initialThreadId" in value ? value.initialThreadId : undefined;
    if (typeof id !== "string" || typeof name !== "string" || typeof primary !== "boolean") {
      return undefined;
    }
    return {
      id,
      name,
      primary,
      ...(typeof initialThreadId === "string" ? { initialThreadId } : {}),
    };
  } catch {
    return undefined;
  }
}
