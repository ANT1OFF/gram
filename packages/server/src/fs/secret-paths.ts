import { InvalidState } from "@gram/contracts";
import { isInside, physicalPathAsync, tryRealPath } from "@gram/git";
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
 * `*_SECRET_FILE` or TLS setting names and the folder holding it, and `GRAM_SECRET_PATHS`. A
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
    if (isAbsolute(path)) paths.add(resolve(path));
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
