import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Same physical-home identity used by provider ownership, including an uncreated suffix.
 * Metadata only: never opens configuration/credentials or creates/prepares a home. */
export const canonicalSessionHome = (path: string): string => {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return join(realpathSync(ancestor), relative(ancestor, absolute));
};
