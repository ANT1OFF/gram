import type { ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { basename, join } from "node:path";
import {
  REGISTRY_SIGN_IN_EXPIRED,
  REGISTRY_UNREADABLE,
  refusedForAge,
  refusedSignIn,
} from "./npm-registry.ts";
import type { Downloader } from "./transaction.ts";
import { fieldsOf } from "@gram/contracts";

const PACK_TIMEOUT_MS = 20 * 60_000;

/** What npm's failure means, in the same words the Agents rows use for the registry. */
export const packFailure = (
  spec: string,
  stderr: string,
): { readonly message: string; readonly notYet?: true } => {
  if (refusedForAge(stderr)) {
    return { message: `Your npm registry doesn't offer ${spec} yet.`, notYet: true };
  }
  if (refusedSignIn(stderr)) return { message: `${REGISTRY_SIGN_IN_EXPIRED}, then try again.` };
  return { message: `${REGISTRY_UNREADABLE} for ${spec}.` };
};

/**
 * Fetches a package with the user's own `npm pack`, so npm applies its own registry, auth,
 * proxy and release-age settings.
 * Gram never reads `.npmrc` itself (it holds tokens). `--ignore-scripts` keeps npm from
 * running anything: a registry package needs no lifecycle script to be packed, and Codex's
 * platform packages have none. No npm means no install, never a fallback to another source.
 */
export const npmPackDownloader = (proc: ProcShape): Downloader => ({
  fetch: (artifact, dir) =>
    Effect.gen(function* () {
      const spec = `${artifact.npm.package}@${artifact.npm.version}`;
      const output = yield* proc
        .run("npm", ["pack", spec, "--pack-destination", dir, "--ignore-scripts", "--json"], {
          cwd: dir,
          timeoutMs: PACK_TIMEOUT_MS,
        })
        .pipe(
          Effect.mapError((error) => ({
            message:
              error._tag === "ProcSpawnError"
                ? "npm isn't installed, and Gram fetches Codex only through your npm registry."
                : `npm pack ${spec} didn't finish: ${error.message}`,
          })),
        );
      if (output.status !== 0) return yield* Effect.fail(packFailure(spec, output.stderr));
      const report = yield* Effect.try({
        try: () => JSON.parse(output.stdout) as unknown,
        catch: () => ({ message: `npm pack ${spec} didn't report what it fetched` }),
      });
      const entry = fieldsOf(Array.isArray(report) ? report[0] : undefined);
      const filename = entry.get("filename");
      const integrity = entry.get("integrity");
      if (
        typeof filename !== "string" ||
        typeof integrity !== "string" ||
        basename(filename) !== filename
      ) {
        return yield* Effect.fail({ message: `npm pack ${spec} reported an unexpected result` });
      }
      return { path: join(dir, filename), integrity };
    }),
});
