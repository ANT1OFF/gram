import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RuntimeInstallRefused, RuntimeInstallState } from "@gram/contracts";
import { ProcSpawnError, type ProcError, type ProcOutput, type ProcShape } from "@gram/git";
import { captureLogs } from "@gram/agents/testing/logs";
import { afterEach, describe, expect, it } from "vitest";
import { npmPackDownloader, packFailure } from "./npm-pack.ts";
import { REGISTRY_SIGN_IN_EXPIRED, REGISTRY_UNREADABLE } from "./npm-registry.ts";
import { makeLeases } from "./leases.ts";
import { makeManagedRuntimes, type ManagedRuntimesShape } from "./service.ts";
import type { RuntimeArtifact } from "./gate.ts";
import { makeRuntimeStore, runtimeRoot, type RuntimeStore } from "./store.ts";
import { extractTarGz, safeArchivePath, UnsafeArchive } from "./tar.ts";
import { install, rollback, type Downloader, type TransactionDeps } from "./transaction.ts";

// ---------------------------------------------------------------------------------------------
// A tar writer, so tests can make the archives a vendor (or an attacker) might ship.

interface Entry {
  readonly name: string;
  readonly type?: "0" | "5" | "2" | "1" | "x";
  readonly body?: string | Buffer;
  readonly mode?: number;
  readonly linkname?: string;
}

const header = (entry: Entry, size: number): Buffer => {
  const block = Buffer.alloc(512);
  block.write(entry.name.slice(0, 100), 0, "utf8");
  block.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(entry.type ?? "0", 156);
  if (entry.linkname !== undefined) block.write(entry.linkname, 157);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};

const tarGz = (entries: ReadonlyArray<Entry>): Buffer => {
  const parts: Array<Buffer> = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    parts.push(header(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};

const pax = (records: Record<string, string>): Entry => {
  let body = "";
  for (const [key, value] of Object.entries(records)) {
    const record = ` ${key}=${value}\n`;
    let length = record.length + 1;
    while (`${length}${record}`.length !== length) length++;
    body += `${length}${record}`;
  }
  return { name: "PaxHeader", type: "x", body };
};

/** A Codex npm platform package: npm's `package/`, then Codex's own layout under `vendor/<target>/`. */
const codexPackage = (version: string, target = "aarch64-apple-darwin", extra: Array<Entry> = []) =>
  tarGz(
    [
      { name: "bin/codex", body: `#!/bin/sh\necho codex-cli ${version}\n`, mode: 0o755 },
      {
        name: "codex-package.json",
        body: JSON.stringify({ layoutVersion: 1, version, target, entrypoint: "bin/codex" }),
      },
      { name: "codex-path/rg", body: "rg", mode: 0o755 },
      ...extra,
    ].map((entry) => ({ ...entry, name: `package/vendor/${target}/${entry.name}` })),
  );

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const integrityOf = (bytes: Buffer) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// ---------------------------------------------------------------------------------------------

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "gram-runtime-")));

const NOW = Date.parse("2026-10-03T00:00:00Z");

/** An approved artifact for `bytes`; `url` is the key the fake registry serves it under. */
const artifactFor = (
  version: string,
  bytes: Buffer,
  overrides: Partial<RuntimeArtifact> = {},
): RuntimeArtifact & { readonly url: string } => ({
  agent: "codex",
  version,
  target: "aarch64-apple-darwin",
  npm: {
    package: "@openai/codex",
    version: `${version}-darwin-arm64`,
    integrity: integrityOf(bytes),
  },
  url: integrityOf(bytes),
  sha256: sha(bytes),
  size: bytes.length,
  publishedAt: "2026-10-01T00:00:00Z",
  artifactUpdatedAt: "2026-10-01T00:00:00Z",
  qualifiedFor: ">=0.8.0 <0.9.0",
  source: "bundled",
  ...overrides,
});

/**
 * A registry serving `files[integrity]`, as `npm pack` would: the tarball in `dir`, and the
 * integrity the registry claims for it. `hang` keeps the fetch open until it is interrupted.
 */
const fakeDownloader = (
  files: Record<string, Buffer>,
  options: {
    readonly hang?: boolean;
    readonly calls?: Array<string>;
    readonly downloaded?: Deferred.Deferred<void>;
  } = {},
): Downloader => ({
  fetch: (artifact, into) =>
    Effect.gen(function* () {
      options.calls?.push(`${artifact.npm.package}@${artifact.npm.version}`);
      const bytes = files[artifact.npm.integrity];
      if (bytes === undefined) return yield* Effect.fail({ message: "E404 not found" });
      const path = join(into, "openai-codex.tgz");
      yield* Effect.promise(() => writeFile(path, bytes));
      if (options.downloaded) yield* Deferred.succeed(options.downloaded, undefined);
      if (options.hang === true) yield* Effect.never;
      return { path, integrity: integrityOf(bytes) };
    }),
});

interface Harness {
  readonly store: RuntimeStore;
  readonly deps: TransactionDeps;
  readonly smoked: Array<string>;
  readonly downloads: Array<string>;
}

const harness = (
  files: Record<string, Buffer>,
  options: {
    readonly smoke?: (executable: string, version: string) => string | undefined;
    readonly hang?: boolean;
    readonly downloaded?: Deferred.Deferred<void>;
  } = {},
): Harness => {
  const store = makeRuntimeStore(join(dir, "agents"), "codex");
  const smoked: Array<string> = [];
  const downloads: Array<string> = [];
  const leases = makeLeases();
  return {
    store,
    smoked,
    downloads,
    deps: {
      store,
      leases,
      downloader: fakeDownloader(files, {
        calls: downloads,
        ...(options.hang ? { hang: true } : {}),
        ...(options.downloaded ? { downloaded: options.downloaded } : {}),
      }),
      smoke: (executable, version) =>
        Effect.suspend(() => {
          smoked.push(executable);
          const failure = options.smoke?.(executable, version);
          return failure === undefined ? Effect.void : Effect.fail({ message: failure });
        }),
      context: () => ({ appVersion: "0.8.0", target: "aarch64-apple-darwin", now: NOW }),
    },
  };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons[0] as { error?: unknown } | undefined)?.error
    : undefined;

describe("extractTarGz", () => {
  it("writes files and directories, honouring PAX paths and the executable bit", async () => {
    tempDir();
    const long = `${"deep/".repeat(30)}file.txt`;
    writeFileSync(
      join(dir, "a.tar.gz"),
      tarGz([
        { name: "bin/", type: "5" },
        { name: "bin/tool", body: "x", mode: 0o755 },
        pax({ path: long }),
        { name: "truncated", body: "long" },
      ]),
    );
    await mkdir(join(dir, "out"));
    const entries = await extractTarGz(join(dir, "a.tar.gz"), join(dir, "out"), {
      maxEntries: 10,
      maxBytes: 1000,
    });
    expect(entries.map((e) => e.path)).toEqual(["bin", "bin/tool", long]);
    expect(readFileSync(join(dir, "out", long), "utf8")).toBe("long");
    expect(entries[1]!.mode).toBe(0o755);
  });

  it.each([
    ["a symlink", [{ name: "bin/codex", type: "2", linkname: "/bin/sh" }]],
    ["a hard link", [{ name: "x", type: "1", linkname: "/etc/passwd" }]],
    ["a parent path", [{ name: "../escape", body: "x" }]],
    ["an absolute path", [{ name: "/tmp/escape", body: "x" }]],
    [
      "a duplicate",
      [
        { name: "a", body: "1" },
        { name: "a", body: "2" },
      ],
    ],
    ["a PAX path escape", [pax({ path: "bin/../../x" }), { name: "ok", body: "x" }]],
  ] as const)("refuses %s", async (_, entries) => {
    tempDir();
    writeFileSync(join(dir, "a.tar.gz"), tarGz(entries as ReadonlyArray<Entry>));
    await mkdir(join(dir, "out"));
    await expect(
      extractTarGz(join(dir, "a.tar.gz"), join(dir, "out"), { maxEntries: 10, maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(UnsafeArchive);
    expect(existsSync(join(dir, "escape"))).toBe(false);
  });

  it("fails, rather than throwing, when the archive can't be read", async () => {
    tempDir();
    await mkdir(join(dir, "out"));
    await expect(
      extractTarGz(join(dir, "missing.tar.gz"), join(dir, "out"), { maxEntries: 10, maxBytes: 10 }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("stops at the size limit", async () => {
    tempDir();
    writeFileSync(join(dir, "a.tar.gz"), tarGz([{ name: "big", body: Buffer.alloc(5000) }]));
    await mkdir(join(dir, "out"));
    await expect(
      extractTarGz(join(dir, "a.tar.gz"), join(dir, "out"), { maxEntries: 10, maxBytes: 4096 }),
    ).rejects.toThrow("too large");
  });

  it("checks names for what Windows would misread", () => {
    expect(() => safeArchivePath("bin\\codex.exe")).toThrow(UnsafeArchive);
    expect(() => safeArchivePath("C:/x")).toThrow(UnsafeArchive);
    expect(() => safeArchivePath("bin/codex.exe:stream")).toThrow(UnsafeArchive);
    expect(() => safeArchivePath("bin./codex")).toThrow(UnsafeArchive);
    expect(safeArchivePath("./bin/codex/")).toBe("bin/codex");
  });
});

describe("the install transaction", () => {
  it("verifies, tests and selects a package, keeping the old one for rollback", async () => {
    tempDir();
    const v1 = codexPackage("0.160.0");
    const v2 = codexPackage("0.161.0");
    const a1 = artifactFor("0.160.0", v1);
    const a2 = artifactFor("0.161.0", v2);
    const h = harness({ [a1.url]: v1, [a2.url]: v2 });
    const phases: Array<string> = [];

    expect(Exit.isSuccess(await run(install(h.deps, a1, (p) => phases.push(p.phase))))).toBe(true);
    expect(phases).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "unpacking",
      "testing",
      "activating",
    ]);
    const second = await run(install(h.deps, a2, () => {}));
    expect(Exit.isSuccess(second)).toBe(true);

    const active = await h.store.readActive();
    expect(active.current?.version).toBe("0.161.0");
    expect(active.previous?.version).toBe("0.160.0");
    expect(active.unproven).toBe(true);
    expect(readFileSync(h.store.executable(active.current!), "utf8")).toContain("0.161.0");
    // Smoke-tested before selection and again from where it now runs.
    expect(h.smoked.filter((p) => p.includes("0.161.0"))).toHaveLength(2);
    expect(readdirSync(h.store.stagingDir)).toEqual([]);

    // Installing what is already selected does nothing.
    await run(install(h.deps, a2, () => {}));
    expect(h.downloads).toHaveLength(2);

    const back = await run(rollback(h.deps));
    expect(Exit.isSuccess(back)).toBe(true);
    const after = await h.store.readActive();
    expect([after.current?.version, after.previous?.version]).toEqual(["0.160.0", "0.161.0"]);
  });

  it("keeps the current and previous versions, and any still running, and prunes the rest", async () => {
    tempDir();
    const versions = ["0.160.0", "0.161.0", "0.162.0", "0.163.0"];
    const files: Record<string, Buffer> = {};
    const artifacts = versions.map((v) => {
      const bytes = codexPackage(v);
      const a = artifactFor(v, bytes);
      files[a.url] = bytes;
      return a;
    });
    const h = harness(files);
    await run(install(h.deps, artifacts[0]!, () => {}));
    const release = h.deps.leases.acquire("0.160.0-aarch64-apple-darwin");
    await run(install(h.deps, artifacts[1]!, () => {}));
    await run(install(h.deps, artifacts[2]!, () => {}));
    expect(readdirSync(h.store.versionsDir).toSorted()).toEqual(
      versions.slice(0, 3).map((v) => `${v}-aarch64-apple-darwin`),
    );
    release();
    await run(install(h.deps, artifacts[3]!, () => {}));
    expect(readdirSync(h.store.versionsDir).toSorted()).toEqual(
      versions.slice(2).map((v) => `${v}-aarch64-apple-darwin`),
    );
  });

  it.each([
    ["a digest mismatch", (a: RuntimeArtifact) => ({ ...a, sha256: "0".repeat(64) }), "verify"],
    ["a size mismatch", (a: RuntimeArtifact) => ({ ...a, size: a.size - 1 }), "verify"],
  ] as const)("refuses %s before unpacking anything", async (_, tamper, step) => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const good = artifactFor("0.160.0", bytes);
    const h = harness({ [good.url]: bytes });
    const exit = await run(install(h.deps, tamper(good), () => {}));
    expect(failureOf(exit)).toMatchObject({ _tag: "RuntimeInstallFailed", step });
    expect(await h.store.readActive()).toEqual({});
    expect(existsSync(h.store.versionsDir)).toBe(false);
    expect(readdirSync(h.store.stagingDir)).toEqual([]);
    expect(h.smoked).toEqual([]);
  });

  it("refuses a package that names another version, or holds a symlink", async () => {
    tempDir();
    const wrong = codexPackage("0.159.0");
    const linked = codexPackage("0.160.0", "aarch64-apple-darwin", [
      { name: "codex-path/sh", type: "2", linkname: "/bin/sh" },
    ]);
    const a = artifactFor("0.160.0", wrong);
    const b = artifactFor("0.160.0", linked);
    const h = harness({ [a.url]: wrong, [b.url]: linked });
    expect(failureOf(await run(install(h.deps, a, () => {})))).toMatchObject({ step: "unpack" });
    expect(failureOf(await run(install(h.deps, b, () => {})))).toMatchObject({ step: "unpack" });
    expect(await h.store.readActive()).toEqual({});
  });

  it("never downloads what the gate refuses", async () => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const fresh = artifactFor("0.160.0", bytes, { publishedAt: "2026-10-02T12:00:00Z" });
    const h = harness({ [fresh.url]: bytes });
    const exit = await run(install(h.deps, fresh, () => {}));
    expect(failureOf(exit)).toMatchObject({ _tag: "RuntimeRefused", reason: "too-new" });
    expect(h.downloads).toEqual([]);
  });

  it("drops a package whose smoke test fails, selecting nothing", async () => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const a = artifactFor("0.160.0", bytes);
    const h = harness({ [a.url]: bytes }, { smoke: () => "initialize failed" });
    expect(failureOf(await run(install(h.deps, a, () => {})))).toMatchObject({ step: "test" });
    expect(await h.store.readActive()).toEqual({});
    expect(readdirSync(h.store.versionsDir)).toEqual([]);
  });

  it("goes straight back when the smoke test fails after activation", async () => {
    tempDir();
    const v1 = codexPackage("0.160.0");
    const v2 = codexPackage("0.161.0");
    const a1 = artifactFor("0.160.0", v1);
    const a2 = artifactFor("0.161.0", v2);
    let runs = 0;
    const h = harness(
      { [a1.url]: v1, [a2.url]: v2 },
      // The second run of 0.161.0's test is the one from its selected path.
      { smoke: (_, version) => (version === "0.161.0" && ++runs === 2 ? "exited (1)" : undefined) },
    );
    await run(install(h.deps, a1, () => {}));
    const exit = await run(install(h.deps, a2, () => {}));
    expect(failureOf(exit)).toMatchObject({ step: "activate" });
    const active = await h.store.readActive();
    expect(active.current?.version).toBe("0.160.0");
    expect(active.rejected).toMatchObject({ id: "0.161.0-aarch64-apple-darwin" });
  });

  it("leaves nothing behind when cancelled mid-download", async () => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const a = artifactFor("0.160.0", bytes);
    const downloaded = await Effect.runPromise(Deferred.make<void>());
    const h = harness({ [a.url]: bytes }, { hang: true, downloaded });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(install(h.deps, a, () => {}));
          // Interrupt after the partial file exists, independent of machine load.
          yield* Deferred.await(downloaded).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(readdirSync(h.store.stagingDir)).toEqual([]);
    expect(await h.store.readActive()).toEqual({});
  });

  it("refuses a rollback with nothing before, or a previous version whose files changed", async () => {
    tempDir();
    const v1 = codexPackage("0.160.0");
    const v2 = codexPackage("0.161.0");
    const a1 = artifactFor("0.160.0", v1);
    const a2 = artifactFor("0.161.0", v2);
    const h = harness({ [a1.url]: v1, [a2.url]: v2 });
    expect(failureOf(await run(rollback(h.deps)))).toMatchObject({ reason: "no-previous" });
    await run(install(h.deps, a1, () => {}));
    await run(install(h.deps, a2, () => {}));
    const active = await h.store.readActive();
    writeFileSync(h.store.executable(active.previous!), "#!/bin/sh\necho tampered\n");
    expect(failureOf(await run(rollback(h.deps)))).toMatchObject({ reason: "previous-damaged" });
    expect((await h.store.readActive()).current?.version).toBe("0.161.0");
  });
});

describe("crash recovery", () => {
  it("empties staging and falls back when the selected version's files are gone", async () => {
    tempDir();
    const v1 = codexPackage("0.160.0");
    const v2 = codexPackage("0.161.0");
    const a1 = artifactFor("0.160.0", v1);
    const a2 = artifactFor("0.161.0", v2);
    const h = harness({ [a1.url]: v1, [a2.url]: v2 });
    await run(install(h.deps, a1, () => {}));
    await run(install(h.deps, a2, () => {}));
    // A crash mid-download, and the selected version deleted behind Gram's back.
    await mkdir(join(h.store.stagingDir, "left-over"), { recursive: true });
    writeFileSync(join(h.store.stagingDir, "left-over", "package.tar.gz"), "partial");
    writeFileSync(join(h.store.dir, ".active-crash.json"), "{");
    rmSync(h.store.versionDir("0.161.0-aarch64-apple-darwin"), { recursive: true });

    const fresh = makeRuntimeStore(join(dir, "agents"), "codex");
    const recovered = await fresh.recover();
    expect(recovered.current?.version).toBe("0.160.0");
    expect(recovered.previous).toBeUndefined();
    expect(existsSync(fresh.stagingDir)).toBe(false);
    expect(readdirSync(fresh.dir).filter((n) => n.startsWith(".active-"))).toEqual([]);
  });

  it("treats a torn active.json as nothing selected", async () => {
    tempDir();
    const store = makeRuntimeStore(join(dir, "agents"), "codex");
    await mkdir(store.dir, { recursive: true });
    writeFileSync(join(store.dir, "active.json"), '{"current": {"id": ');
    expect(await store.recover()).toEqual({});
  });

  it("keeps the store out of the roaming profile on Windows", () => {
    expect(
      runtimeRoot("C:\\Users\\j\\AppData\\Roaming\\gram-state", "win32", {
        LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local",
      }),
    ).toMatch(/AppData[\\/]Local[\\/]Gram[\\/]agents$/);
    expect(runtimeRoot("/Users/j/Library/Application Support/gram-state", "darwin")).toBe(
      "/Users/j/Library/Application Support/gram-state/agents",
    );
  });
});

/** Polls the install state until it is `until`. */
const settle = (runtimes: ManagedRuntimesShape, until: RuntimeInstallState["state"]) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      const state = yield* runtimes.state("codex");
      if (state.state === until) return state;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`never reached ${until}`));
  });

const reasonOf = <A>(effect: Effect.Effect<A, RuntimeInstallRefused>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((e) => e.reason),
  );

describe("ManagedRuntimes", () => {
  interface Fixture {
    readonly runtimes: ManagedRuntimesShape;
    readonly events: Array<string>;
    readonly setBusy: (n: number) => void;
    readonly states: Array<RuntimeInstallState>;
  }

  /** A managed store on the fake downloader, with `versions` approved and hooks that record. */
  const withRuntimes = <A>(
    versions: ReadonlyArray<string>,
    body: (fixture: Fixture) => Effect.Effect<A, unknown, Scope.Scope>,
    options: {
      readonly source?: "managed" | "path";
      readonly smoke?: Effect.Effect<void>;
    } = {},
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const files: Record<string, Buffer> = {};
          const baseline = versions.map((v) => {
            const bytes = codexPackage(v);
            const a = artifactFor(v, bytes, { qualifiedFor: undefined });
            files[a.url] = bytes;
            return a;
          });
          const events: Array<string> = [];
          let busy = 0;
          let source: "managed" | "path" = options.source ?? "managed";
          const runtimes = yield* makeManagedRuntimes({
            root: join(dir, "agents"),
            appVersion: "0.8.0",
            target: "aarch64-apple-darwin",
            now: () => NOW,
            baseline,
            downloader: fakeDownloader(files),
            smoke: () => options.smoke ?? Effect.void,
            idlePollMs: 10,
          });
          yield* runtimes.connect({
            readSource: Effect.sync(() => source),
            writeSource: (next) =>
              Effect.sync(() => {
                source = next;
                events.push(`source ${next}`);
              }),
            busySessions: Effect.sync(() => busy),
            switched: Effect.sync(() => void events.push("switched")),
          });
          const states: Array<RuntimeInstallState> = [];
          yield* Effect.forkScoped(
            Stream.runForEach(runtimes.watch("codex"), (s) =>
              Effect.sync(() => void states.push(s)),
            ),
          );
          return yield* body({ runtimes, events, setBusy: (n) => void (busy = n), states });
        }),
      ),
    );

  it("installs, waits for busy managed sessions before switching, and rolls back on request", async () => {
    tempDir();
    await withRuntimes(["0.160.0", "0.161.0"], ({ runtimes, events, setBusy, states }) =>
      Effect.gen(function* () {
        yield* runtimes.install("codex", "0.160.0");
        expect((yield* settle(runtimes, "idle")).active?.version).toBe("0.160.0");
        expect(events).toEqual(["switched"]);

        setBusy(2);
        yield* runtimes.install("codex", "0.161.0");
        const ready = yield* settle(runtimes, "ready");
        expect(ready).toMatchObject({ version: "0.161.0", activeSessions: 2 });
        expect(ready.active?.version).toBe("0.160.0");
        setBusy(0);
        expect((yield* settle(runtimes, "idle")).active?.version).toBe("0.161.0");
        expect(states.map((s) => s.state)).toContain("testing");

        const back = yield* runtimes.rollback("codex");
        expect([back.active?.version, back.previous?.version]).toEqual(["0.160.0", "0.161.0"]);
        expect(events).toEqual(["switched", "switched", "switched"]);
      }),
    );
  });

  it("refuses what isn't approved, a second install, and the managed source with nothing installed", async () => {
    tempDir();
    await withRuntimes(
      ["0.160.0"],
      ({ runtimes }) =>
        Effect.gen(function* () {
          expect(yield* reasonOf(runtimes.install("codex", "0.999.0"))).toBe("not-approved");
          expect(yield* reasonOf(runtimes.install("claude", "2.1.284"))).toBe("unsupported");
          expect(yield* reasonOf(runtimes.rollback("codex"))).toBe("nothing-to-roll-back");
          expect(yield* reasonOf(runtimes.useSource("codex", "managed"))).toBe("unsupported");
          yield* runtimes.install("codex", "0.160.0");
          expect(yield* reasonOf(runtimes.install("codex", "0.160.0"))).toBe("busy");
          yield* settle(runtimes, "idle");
        }),
      { source: "path" },
    );
  });

  it("gives the adapter the managed executable only when chosen, and rolls back an update that won't start", async () => {
    tempDir();
    await withRuntimes(
      ["0.160.0", "0.161.0"],
      ({ runtimes, events }) =>
        Effect.gen(function* () {
          expect(yield* runtimes.codexSource.resolve).toBeUndefined();
          const missing = yield* Effect.flip(
            runtimes.useSource("codex", "managed").pipe(Effect.as("ok")),
          );
          expect(missing.reason).toBe("unsupported");

          // Installing leaves the user's own codex in use; choosing the managed one is theirs.
          yield* runtimes.install("codex", "0.160.0");
          yield* settle(runtimes, "idle");
          expect(events).toEqual([]);
          expect(yield* runtimes.codexSource.resolve).toBeUndefined();
          yield* runtimes.useSource("codex", "managed");
          expect(events).toEqual(["source managed", "switched"]);
          const first = (yield* runtimes.codexSource.resolve)!;
          expect(first.version).toBe("0.160.0");
          yield* first.started;
          first.release();

          yield* runtimes.install("codex", "0.161.0");
          yield* settle(runtimes, "idle");
          const updated = (yield* runtimes.codexSource.resolve)!;
          expect(updated.version).toBe("0.161.0");
          // A pre-turn startup failure of a version that has never started a session rolls back.
          const logs = captureLogs();
          expect(
            yield* updated.failed("initialize: no answer").pipe(Effect.provide(logs.layer)),
          ).toBe(true);
          expect(logs.warnings().map((log) => log.message)).toEqual([
            "managed Codex 0.161.0 didn't start; rolled back to 0.160.0",
          ]);
          updated.release();
          const state = yield* runtimes.state("codex");
          expect(state).toMatchObject({ state: "rolledBack", from: "0.161.0" });
          expect(state.active?.version).toBe("0.160.0");
          const again = (yield* runtimes.codexSource.resolve)!;
          expect(again.version).toBe("0.160.0");
          // A proven version that fails to start is not the update's fault.
          expect(yield* again.failed("network")).toBe(false);
        }),
      { source: "path" },
    );
  });

  it("cancels an install before it switches, leaving nothing selected", async () => {
    tempDir();
    await withRuntimes(["0.160.0"], ({ runtimes, setBusy }) =>
      Effect.gen(function* () {
        setBusy(1);
        yield* runtimes.install("codex", "0.160.0");
        yield* settle(runtimes, "ready");
        const after = yield* runtimes.cancel("codex");
        expect(after.state).toBe("idle");
        expect(after.active).toBeUndefined();
        expect(readdirSync(join(dir, "agents", "codex", "versions"))).toEqual([]);
      }),
    );
  });

  it("lets one install in at a time, and repairs a damaged one", async () => {
    tempDir();
    await withRuntimes(["0.160.0", "0.161.0"], ({ runtimes }) =>
      Effect.gen(function* () {
        const both = yield* Effect.all(
          [
            Effect.result(runtimes.install("codex", "0.160.0")),
            Effect.result(runtimes.install("codex", "0.160.0")),
          ],
          { concurrency: 2 },
        );
        expect(both.filter((r) => r._tag === "Failure")).toHaveLength(1);
        const active = (yield* settle(runtimes, "idle")).active!;
        expect((yield* runtimes.allowed("codex")).map((a) => a.version)).toEqual([
          "0.161.0",
          "0.160.0",
        ]);

        writeFileSync(active.path, "#!/bin/sh\necho tampered\n");
        yield* runtimes.install("codex", "0.160.0");
        const repaired = yield* settle(runtimes, "idle");
        expect(readFileSync(repaired.active!.path, "utf8")).toContain("codex-cli 0.160.0");
      }),
    );
  });

  it("starts nothing from a selected version while it is being repaired", async () => {
    tempDir();
    let hold: Deferred.Deferred<void> | undefined;
    const smoke = Effect.suspend(() => (hold === undefined ? Effect.void : Deferred.await(hold)));
    await withRuntimes(
      ["0.160.0"],
      ({ runtimes }) =>
        Effect.gen(function* () {
          yield* runtimes.install("codex", "0.160.0");
          const active = (yield* settle(runtimes, "idle")).active!;
          writeFileSync(active.path, "#!/bin/sh\necho tampered\n");
          hold = yield* Deferred.make<void>();
          yield* runtimes.install("codex", "0.160.0");
          yield* settle(runtimes, "testing");
          const during = yield* Effect.flip(runtimes.codexSource.resolve);
          expect(during.message).toContain("being repaired");
          yield* Deferred.succeed(hold, undefined);
          yield* settle(runtimes, "idle");
          const after = (yield* runtimes.codexSource.resolve)!;
          expect(after.version).toBe("0.160.0");
          after.release();
        }),
      { smoke, source: "managed" },
    );
  });

  it("keeps a staged update while it waits, even when a running version's lease ends", async () => {
    tempDir();
    await withRuntimes(["0.160.0", "0.161.0"], ({ runtimes, setBusy }) =>
      Effect.gen(function* () {
        yield* runtimes.install("codex", "0.160.0");
        yield* settle(runtimes, "idle");
        const running = (yield* runtimes.codexSource.resolve)!;
        setBusy(1);
        yield* runtimes.install("codex", "0.161.0");
        yield* settle(runtimes, "ready");
        running.release();
        yield* Effect.sleep(50);
        expect(readdirSync(join(dir, "agents", "codex", "versions"))).toContain(
          "0.161.0-aarch64-apple-darwin",
        );
        setBusy(0);
        expect((yield* settle(runtimes, "idle")).active?.version).toBe("0.161.0");
      }),
    );
  });

  it("fetches with the user's own npm, and says so when there is none", async () => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const artifact = artifactFor("0.160.0", bytes);
    const calls: Array<ReadonlyArray<string>> = [];
    const proc = (answer: (dir: string) => Effect.Effect<ProcOutput, ProcError>): ProcShape => ({
      run: (bin, args, options) => {
        calls.push([bin, ...args]);
        return answer(options.cwd);
      },
    });
    const packed = npmPackDownloader(
      proc((cwd) =>
        Effect.sync(() => {
          writeFileSync(join(cwd, "openai-codex-0.160.0-darwin-arm64.tgz"), bytes);
          return {
            status: 0,
            stdout: JSON.stringify([
              { filename: "openai-codex-0.160.0-darwin-arm64.tgz", integrity: integrityOf(bytes) },
            ]),
            stderr: "",
            truncated: false,
          };
        }),
      ),
    );
    const h = harness({});
    const exit = await run(install({ ...h.deps, downloader: packed }, artifact, () => {}));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls[0]).toEqual([
      "npm",
      "pack",
      "@openai/codex@0.160.0-darwin-arm64",
      "--pack-destination",
      expect.any(String),
      "--ignore-scripts",
      "--json",
    ]);

    const missing = npmPackDownloader(
      proc(() => Effect.fail(new ProcSpawnError({ bin: "npm", message: "ENOENT" }))),
    );
    expect(failureOf(await run(missing.fetch(artifact, dir)))).toMatchObject({
      message: expect.stringContaining("npm isn't installed"),
    });
    const refused = npmPackDownloader(
      proc(() =>
        Effect.succeed({
          status: 1,
          stdout: "",
          stderr: "npm error code E401\nnpm error Unable to authenticate\n",
          truncated: false,
        }),
      ),
    );
    expect(failureOf(await run(refused.fetch(artifact, dir)))).toMatchObject({
      message: expect.stringContaining("npm registry sign-in expired"),
    });
    const sideways = npmPackDownloader(
      proc(() =>
        Effect.succeed({
          status: 0,
          stdout: JSON.stringify([{ filename: "../x.tgz", integrity: integrityOf(bytes) }]),
          stderr: "",
          truncated: false,
        }),
      ),
    );
    expect(failureOf(await run(sideways.fetch(artifact, dir)))).toMatchObject({
      message: expect.stringContaining("unexpected"),
    });
  });

  it("tells an expired npm registry sign-in from an unreachable registry and a version not offered yet", () => {
    const spec = "@openai/codex@0.160.0-darwin-arm64";
    expect(packFailure(spec, "npm error code E401\nnpm error Unable to authenticate").message).toBe(
      `${REGISTRY_SIGN_IN_EXPIRED}, then try again.`,
    );
    expect(packFailure(spec, "npm ERR! code E403").message).toContain("npm login");
    for (const code of ["E404", "E407", "E429", "ETIMEDOUT"]) {
      expect(packFailure(spec, `npm error code ${code}`).message).toContain(REGISTRY_UNREADABLE);
    }
    expect(
      packFailure(spec, "npm error code ETARGET\nnpm error No matching version"),
    ).toMatchObject({
      notYet: true,
    });
  });

  it("refuses a package whose registry integrity isn't the approved one", async () => {
    tempDir();
    const bytes = codexPackage("0.160.0");
    const artifact = artifactFor("0.160.0", bytes);
    const h = harness({});
    const lying: Downloader = {
      fetch: (_, into) =>
        Effect.promise(async () => {
          await writeFile(join(into, "a.tgz"), bytes);
          return { path: join(into, "a.tgz"), integrity: integrityOf(Buffer.from("other")) };
        }),
    };
    const exit = await run(install({ ...h.deps, downloader: lying }, artifact, () => {}));
    expect(failureOf(exit)).toMatchObject({ step: "verify" });
    expect(await h.store.readActive()).toEqual({});
  });
});
