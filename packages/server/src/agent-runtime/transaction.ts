/**
 * The install, update and rollback transaction for a managed runtime. One runs at a time. Each step
 * either completes or leaves the selection as it was:
 *
 * 1. the gate approves the exact artifact (qualified for this build, at least 24 hours old);
 * 2. the npm tarball is fetched into a fresh staging directory through the user's own registry
 *    (`Downloader`), and the integrity the registry reports, its size, its SHA-256 and its SHA-512
 *    must all match the approved values before anything is unpacked;
 * 3. it unpacks through `extractTarGz`, and the `codex-package.json` under
 *    `package/vendor/<target>/` must name the same version and target and an entrypoint inside;
 * 4. the package moves into `versions/`, where `codex --version` and an app-server handshake run
 *    against an empty `CODEX_HOME`;
 * 5. `active.json` is replaced to select it, keeping the old selection as `previous`, and the smoke
 *    test runs again from the selected path; if that fails the selection goes straight back.
 *
 * Interrupting it (Cancel) before step 5 deletes the staging directory and changes nothing; step 5
 * is uninterruptible. A crash anywhere leaves at most an unselected directory, which `recover`
 * and `prune` clean up.
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isStrictlyInside } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Leases } from "./leases.ts";
import { gate, type GateContext, type RuntimeArtifact } from "./gate.ts";
import {
  hashFile,
  sha256File,
  versionId,
  type ActiveRecord,
  type RuntimeReceipt,
  type RuntimeStore,
} from "./store.ts";
import { extractTarGz, safeArchivePath, UnsafeArchive } from "./tar.ts";

export class RuntimeRefused extends Schema.TaggedError<RuntimeRefused>()("RuntimeRefused", {
  reason: Schema.String,
  message: Schema.String,
}) {}

export class RuntimeInstallFailed extends Schema.TaggedError<RuntimeInstallFailed>()(
  "RuntimeInstallFailed",
  {
    step: Schema.Literals(["download", "verify", "unpack", "test", "activate"]),
    message: Schema.String,
  },
) {}

export type InstallPhase =
  | { readonly phase: "downloading"; readonly received: number; readonly total: number }
  | { readonly phase: "verifying" }
  | { readonly phase: "unpacking" }
  | { readonly phase: "testing" }
  | { readonly phase: "activating" };

export interface Downloader {
  /**
   * Fetches `artifact`'s tarball into the empty directory `dir`, through the user's own registry,
   * and resolves to its path and the integrity the registry reported for it. Interrupting it stops
   * the fetch.
   */
  readonly fetch: (
    artifact: RuntimeArtifact,
    dir: string,
  ) => Effect.Effect<
    { readonly path: string; readonly integrity: string },
    /** `notYet`: the registry doesn't offer the version yet (its own release-age hold). */
    { readonly message: string; readonly notYet?: true | undefined }
  >;
}

export interface TransactionDeps {
  readonly store: RuntimeStore;
  readonly leases: Leases;
  readonly downloader: Downloader;
  /** `--version` plus an app-server handshake in an empty home; fails with a message. */
  readonly smoke: (
    executable: string,
    version: string,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly context: () => GateContext;
}

/** Unpack limits: generous for a ~600 MB package, and short of a gzip bomb filling the disk. */
const UNPACK_LIMITS = { maxEntries: 20_000, maxBytes: 4 * 1024 * 1024 * 1024 };

const fail = (step: RuntimeInstallFailed["step"], message: string) =>
  new RuntimeInstallFailed({ step, message });

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PackageManifest {
  readonly version: string;
  readonly target: string;
  readonly entrypoint: string;
}

const readManifest = async (dir: string): Promise<PackageManifest> => {
  const value: unknown = JSON.parse(await readFile(join(dir, "codex-package.json"), "utf8"));
  const m = value as Record<string, unknown> | null;
  if (
    m === null ||
    typeof m !== "object" ||
    m["layoutVersion"] !== 1 ||
    typeof m["version"] !== "string" ||
    typeof m["target"] !== "string" ||
    typeof m["entrypoint"] !== "string"
  ) {
    throw new Error("codex-package.json isn't a layout-1 Codex package manifest");
  }
  return { version: m["version"], target: m["target"], entrypoint: m["entrypoint"] };
};

/** The keep set for `prune`: what is selected, what rollback needs, and anything still running. */
export const keepSet = (record: ActiveRecord, leases: Leases): ReadonlySet<string> => {
  const keep = new Set(leases.held());
  if (record.current !== undefined) keep.add(record.current.id);
  if (record.previous !== undefined) keep.add(record.previous.id);
  return keep;
};

/**
 * Installs and selects `artifact`: `stage`, then `activate`. `onPhase` reports progress. Resolves
 * to the receipt now selected.
 */
export const install = (
  deps: TransactionDeps,
  artifact: RuntimeArtifact,
  onPhase: (phase: InstallPhase) => void,
): Effect.Effect<RuntimeReceipt, RuntimeRefused | RuntimeInstallFailed> =>
  stage(deps, artifact, onPhase).pipe(
    Effect.flatMap((staged) =>
      staged.selected ? Effect.succeed(staged.receipt) : activate(deps, staged.receipt, onPhase),
    ),
  );

/**
 * Steps 1–4: puts `artifact` in `versions/`, verified and smoke-tested, without selecting it.
 * `selected` when it already was (and is intact), so there is nothing to activate.
 */
export const stage = (
  deps: TransactionDeps,
  artifact: RuntimeArtifact,
  onPhase: (phase: InstallPhase) => void,
): Effect.Effect<
  { readonly receipt: RuntimeReceipt; readonly selected: boolean },
  RuntimeRefused | RuntimeInstallFailed
> =>
  Effect.gen(function* () {
    const { store } = deps;
    const refusal = gate(artifact, deps.context());
    if (refusal !== undefined) {
      return yield* new RuntimeRefused({ reason: refusal.reason, message: refusal.message });
    }
    const id = versionId(artifact.version, artifact.target);
    const before = yield* Effect.promise(() => store.readActive());
    if (before.current?.id === id && before.current.archiveSha256 === artifact.sha256) {
      if (yield* Effect.promise(() => store.intact(before.current!))) {
        return { receipt: before.current, selected: true };
      }
    }
    if (
      before.previous?.id === id &&
      before.previous.archiveSha256 === artifact.sha256 &&
      (yield* Effect.promise(() => store.intact(before.previous!)))
    ) {
      // Already unpacked and verified: selecting it is all that's left.
      return { receipt: before.previous, selected: false };
    }
    const sameId = [before.current, before.previous].find((receipt) => receipt?.id === id);
    if (sameId !== undefined && sameId.archiveSha256 !== artifact.sha256) {
      // Same version and target, different bytes: the vendor replaced the asset. Overwriting the
      // directory would change what is selected without the activation step, so it is refused.
      // The same bytes with damaged files on disk fall through to a fresh install: a repair.
      return yield* new RuntimeRefused({
        reason: "replaced",
        message: `Codex ${artifact.version}'s package differs from the one installed; it needs approving again.`,
      });
    }
    if (deps.leases.count(id) > 0) {
      // A process runs from the directory a reinstall would replace; that would pull its files out
      // from under it.
      return yield* new RuntimeRefused({
        reason: "in-use",
        message: `Codex ${artifact.version} is running from an earlier install; try again once its sessions close.`,
      });
    }

    const receipt = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => store.makeStaging(),
        catch: (error) =>
          fail("download", `couldn't create the staging folder: ${describe(error)}`),
      }),
      (staging) => stageAndCommit(deps, artifact, id, staging, onPhase),
      (staging) =>
        Effect.promise(() => rm(staging, { recursive: true, force: true, maxRetries: 5 })),
    );
    return { receipt, selected: false };
  });

const stageAndCommit = (
  deps: TransactionDeps,
  artifact: RuntimeArtifact,
  id: string,
  staging: string,
  onPhase: (phase: InstallPhase) => void,
) =>
  Effect.gen(function* () {
    const { store } = deps;
    onPhase({ phase: "downloading", received: 0, total: artifact.size });
    const download = join(staging, "download");
    yield* Effect.promise(() => mkdir(download));
    const fetched = yield* deps.downloader
      .fetch(artifact, download)
      .pipe(
        Effect.mapError((error) =>
          error.notYet === true
            ? new RuntimeRefused({ reason: "too-new", message: error.message })
            : fail("download", error.message),
        ),
      );
    const archive = fetched.path;
    if (!isStrictlyInside(download, archive)) {
      return yield* fail("download", "the registry's tarball landed outside the staging folder");
    }
    onPhase({ phase: "downloading", received: artifact.size, total: artifact.size });

    onPhase({ phase: "verifying" });
    if (fetched.integrity !== artifact.npm.integrity) {
      return yield* fail(
        "verify",
        "the registry's integrity for the package isn't the approved one",
      );
    }
    const onDisk = yield* Effect.promise(() =>
      stat(archive).then(
        (info) => info.size,
        () => -1,
      ),
    );
    if (onDisk !== artifact.size) {
      return yield* fail(
        "verify",
        `the download is ${onDisk} bytes; the approved package is ${artifact.size}`,
      );
    }
    // Hashed from disk ourselves: what npm reports is a claim, these are the bytes.
    const digests = yield* Effect.tryPromise({
      try: (signal) => hashFile(archive, signal),
      catch: (error) => fail("verify", describe(error)),
    });
    if (digests.sha256 !== artifact.sha256) {
      return yield* fail("verify", "the download's SHA-256 doesn't match the approved package");
    }
    if (digests.integrity !== artifact.npm.integrity) {
      return yield* fail("verify", "the download's SHA-512 doesn't match the approved integrity");
    }

    onPhase({ phase: "unpacking" });
    const unpacked = join(staging, "unpacked");
    yield* Effect.tryPromise({
      try: async (signal) => {
        await mkdir(unpacked);
        await extractTarGz(archive, unpacked, UNPACK_LIMITS, signal);
      },
      catch: (error) =>
        fail(
          "unpack",
          error instanceof UnsafeArchive
            ? `the package holds something it shouldn't: ${error.message}`
            : describe(error),
        ),
    });
    yield* Effect.promise(() => rm(download, { recursive: true, force: true }));
    // An npm tarball's files sit under `package/`; Codex's own package layout is beneath it.
    const root = join(unpacked, "package", "vendor", artifact.target);
    const isDir = yield* Effect.promise(() =>
      stat(root).then(
        (info) => info.isDirectory(),
        () => false,
      ),
    );
    if (!isDir) return yield* fail("unpack", `the package has no vendor/${artifact.target}`);
    const manifest = yield* Effect.tryPromise({
      try: () => readManifest(root),
      catch: (error) => fail("unpack", describe(error)),
    });
    if (manifest.version !== artifact.version || manifest.target !== artifact.target) {
      return yield* fail(
        "unpack",
        `the package is Codex ${manifest.version} for ${manifest.target}, not ${artifact.version} for ${artifact.target}`,
      );
    }
    const entrypoint = yield* Effect.try({
      try: () => safeArchivePath(manifest.entrypoint),
      catch: (error) => fail("unpack", `bad entrypoint: ${describe(error)}`),
    });
    if (artifact.target.includes("-windows-") && !entrypoint.toLowerCase().endsWith(".exe")) {
      return yield* fail("unpack", `the entrypoint ${entrypoint} isn't a Windows executable`);
    }
    const isFile = yield* Effect.promise(() =>
      stat(join(root, entrypoint)).then(
        (info) => info.isFile(),
        () => false,
      ),
    );
    if (!isFile) return yield* fail("unpack", `the package has no ${entrypoint}`);

    // Moved in before it runs, so Windows never renames a folder whose executable just exited.
    yield* Effect.tryPromise({
      try: () => store.commit(root, id),
      catch: (error) => fail("unpack", `couldn't move the package into place: ${describe(error)}`),
    });
    const executable = join(store.versionDir(id), entrypoint);
    if (!isStrictlyInside(store.versionDir(id), executable)) {
      return yield* fail("unpack", `the entrypoint ${entrypoint} is outside the package`);
    }
    onPhase({ phase: "testing" });
    yield* deps.smoke(executable, artifact.version).pipe(
      Effect.mapError((error) => fail("test", error.message)),
      Effect.tapError(() =>
        Effect.promise(() =>
          rm(store.versionDir(id), { recursive: true, force: true, maxRetries: 5 }),
        ),
      ),
    );
    const entrypointSha256 = yield* Effect.tryPromise({
      try: () => sha256File(executable),
      catch: (error) => fail("verify", describe(error)),
    });
    const receipt: RuntimeReceipt = {
      id,
      version: artifact.version,
      target: artifact.target,
      archiveSha256: artifact.sha256,
      archiveSize: artifact.size,
      entrypoint,
      entrypointSha256,
      source: artifact.source,
      installedAt: new Date(deps.context().now).toISOString(),
    };
    return receipt;
  });

/**
 * Step 5: selects a staged `receipt`, smoke-tests it from where it now runs, and reverts to the
 * selection before if that fails.
 */
export const activate = (
  deps: TransactionDeps,
  receipt: RuntimeReceipt,
  onPhase: (phase: InstallPhase) => void,
): Effect.Effect<RuntimeReceipt, RuntimeInstallFailed> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { store } = deps;
      onPhase({ phase: "activating" });
      const before = yield* Effect.promise(() => store.readActive());
      if (
        before.current?.id === receipt.id &&
        before.current.entrypointSha256 === receipt.entrypointSha256 &&
        (yield* Effect.promise(() => store.intact(receipt)))
      ) {
        return before.current;
      }
      // A repair of the selected version keeps the previous one; anything else becomes it.
      const previous = before.current?.id === receipt.id ? before.previous : before.current;
      const next: ActiveRecord = {
        current: receipt,
        ...(previous === undefined ? {} : { previous }),
        unproven: true,
      };
      yield* Effect.tryPromise({
        try: () => store.writeActive(next),
        catch: (error) => fail("activate", describe(error)),
      });
      const healthy = yield* Effect.promise(() => store.intact(receipt)).pipe(
        Effect.flatMap((ok) =>
          ok
            ? deps.smoke(store.executable(receipt), receipt.version).pipe(
                Effect.as(undefined),
                Effect.catch((error) => Effect.succeed(error.message)),
              )
            : Effect.succeed("its executable changed after it was verified"),
        ),
      );
      if (healthy !== undefined) {
        yield* Effect.promise(() =>
          store.writeActive({
            ...before,
            rejected: {
              id: receipt.id,
              message: healthy,
              at: new Date(deps.context().now).toISOString(),
            },
          }),
        );
        yield* Effect.promise(() => store.prune(keepSet(before, deps.leases)));
        return yield* fail(
          "activate",
          `Codex ${receipt.version} failed after activation: ${healthy}`,
        );
      }
      yield* Effect.promise(() => store.prune(keepSet(next, deps.leases)));
      return receipt;
    }),
  );

/**
 * Selects the previous version again, keeping the current one as the new `previous` so the
 * switch can be undone. Refused when there is no previous version or its files changed.
 */
export const rollback = (
  deps: TransactionDeps,
  reason?: string,
): Effect.Effect<RuntimeReceipt, RuntimeRefused | RuntimeInstallFailed> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { store } = deps;
      const before = yield* Effect.promise(() => store.readActive());
      const previous = before.previous;
      if (previous === undefined) {
        return yield* new RuntimeRefused({
          reason: "no-previous",
          message: "There's no earlier Codex to go back to.",
        });
      }
      if (!(yield* Effect.promise(() => store.intact(previous)))) {
        return yield* new RuntimeRefused({
          reason: "previous-damaged",
          message: `Codex ${previous.version}'s files changed since it was verified, so it can't be used.`,
        });
      }
      const next: ActiveRecord = {
        current: previous,
        ...(before.current === undefined ? {} : { previous: before.current }),
        ...(reason === undefined || before.current === undefined
          ? {}
          : {
              rejected: {
                id: before.current.id,
                message: reason,
                at: new Date(deps.context().now).toISOString(),
              },
            }),
      };
      yield* Effect.tryPromise({
        try: () => store.writeActive(next),
        catch: (error) => fail("activate", describe(error)),
      });
      return previous;
    }),
  );
