import { InvalidState } from "@gram/contracts";
import { isInside, physicalPathAsync, tryRealPath, tryRealPathSync } from "@gram/git";
import type { FileHandle } from "node:fs/promises";
import { readlink } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

/**
 * Extra places a deployment keeps secrets in, beside the files its other settings name:
 * `GRAM_SECRET_PATHS`, absolute paths (files or folders) separated by the platform's path
 * delimiter. Every file below one is refused by every preview and file read.
 */
export const SECRET_PATHS_ENV = "GRAM_SECRET_PATHS";

/** Settings that name a file a deployment supplies as a secret, by their variable's name. */
const namesSecretFile = (name: string): boolean =>
  name.startsWith("GRAM_") &&
  (name.endsWith("_TOKEN_FILE") ||
    name.endsWith("_SECRET_FILE") ||
    name === "GRAM_PROVISIONED_TLS_CERT" ||
    name === "GRAM_PROVISIONED_TLS_KEY");

/**
 * Where this deployment keeps its secrets, from its environment: each file a `*_TOKEN_FILE`,
 * `*_SECRET_FILE` or TLS setting names and the folder holding it, and `GRAM_SECRET_PATHS`, which
 * throws on a relative entry so such a server doesn't start. A
 * holding folder that is or holds `dataDir` stays readable, so a token kept beside the data
 * refuses only itself, not every thread's files.
 */
export const secretPathsFrom = (
  env: Record<string, string | undefined>,
  dataDir: string,
): ReadonlyArray<string> => {
  const paths = new Set<string>();
  const data = resolve(dataDir);
  for (const [name, value] of Object.entries(env)) {
    const file = value?.trim() ?? "";
    if (!namesSecretFile(name) || !isAbsolute(file)) continue;
    paths.add(resolve(file));
    const folder = dirname(resolve(file));
    if (!isInside(folder, data)) paths.add(folder);
  }
  for (const listed of (env[SECRET_PATHS_ENV] ?? "").split(delimiter)) {
    const path = listed.trim();
    if (path === "") continue;
    // A secret named from the working directory, or mistyped, must not leave the server unfenced.
    if (!isAbsolute(path))
      throw new Error(`${SECRET_PATHS_ENV} takes absolute paths only; ${path} isn't one.`);
    paths.add(resolve(path));
  }
  return [...paths];
};

/** What a read of a deployment's secret is refused with; it names only the path asked for. */
const secretRefusal = (path: string) =>
  new InvalidState({ message: `Gram doesn't preview files that may hold credentials: ${path}` });

/** Whether `path`, where it really is, lies in one of `secrets`, where they really are. */
export const isSecretPath = (
  path: string,
  secrets: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  secrets.length === 0
    ? Effect.succeed(false)
    : Effect.promise(async () => {
        const at = await physicalPathAsync(resolve(path));
        for (const secret of secrets) {
          const real = (await tryRealPath(secret)) ?? resolve(secret);
          if (isInside(real, at) || isInside(resolve(secret), resolve(path))) return true;
        }
        return false;
      });

/** Refuses `path` when it is one of the deployment's `secrets`, by where it really is. */
export const refuseSecretPath = (
  path: string,
  secrets: ReadonlyArray<string>,
): Effect.Effect<void, InvalidState> =>
  Effect.flatMap(isSecretPath(path, secrets), (secret) =>
    secret ? Effect.fail(secretRefusal(path)) : Effect.void,
  );

/**
 * `secrets` where each really is, taken once: what a synchronous check of an already resolved
 * path (`insideSecret`) compares against. One that doesn't exist yet is kept as written.
 */
export const realSecretPaths = (secrets: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    secrets.flatMap((secret) => [resolve(secret), tryRealPathSync(secret) ?? resolve(secret)]),
  ),
];

/** Whether `real`, a resolved path, is in one of `realSecrets` (`realSecretPaths`). */
export const insideSecret = (real: string, realSecrets: ReadonlyArray<string>): boolean =>
  realSecrets.some((secret) => isInside(secret, real));

/**
 * Refuses the file `handle` holds when it is one of the deployment's secrets: by the name the
 * kernel gives the open file on Linux, which no link swapped in after the open can change, else
 * by `path`'s real path.
 */
export const refuseSecretHandle = (
  handle: FileHandle,
  path: string,
  realSecrets: ReadonlyArray<string>,
): Effect.Effect<void, InvalidState> =>
  realSecrets.length === 0
    ? Effect.void
    : Effect.flatMap(
        Effect.promise(async () =>
          process.platform === "linux"
            ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => physicalPathAsync(path))
            : await physicalPathAsync(path),
        ),
        (real) =>
          insideSecret(real, realSecrets) ? Effect.fail(secretRefusal(path)) : Effect.void,
      );
