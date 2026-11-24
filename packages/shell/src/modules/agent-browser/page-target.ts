import type { PageTarget } from "../../core/page-driver.ts";

/** The page target a command names: its ref, else its coordinate; a command with neither is a bug. */
export const targetOf = (point: {
  readonly ref?: string | undefined;
  readonly coordinate?: readonly [number, number] | undefined;
}): PageTarget => {
  if (point.ref !== undefined) return { ref: point.ref };
  if (point.coordinate !== undefined) return { coordinate: point.coordinate };
  throw new Error("The command names no target.");
};
