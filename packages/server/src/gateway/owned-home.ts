// A home of Gram's own for an agent CLI: a private folder that holds only what Gram writes, apart
// from the person's own, and the environment the CLI starts with beside it.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { realPathOrOwned } from "@gram/git";

/**
 * Makes `config`, inside `home`, a private folder of Gram's own, refusing when it is the person's
 * own `native` one.
 */
export const ownedConfigFolder = async (
  home: string,
  config: string,
  native: string,
): Promise<void> => {
  if ((await realPathOrOwned(native)) === (await realPathOrOwned(config)))
    throw new Error("Native and owned homes coincide");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(config, 0o700);
};

/** Writes `content` to `file`, readable by its owner alone, in a folder made private if new. */
export const writePrivate = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
};

/** `env` without the names `inherited` says would bring the person's own config back. */
export const envWithout = (
  env: Readonly<Record<string, string>>,
  inherited: (name: string) => boolean,
): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !inherited(name)));
