import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { codexSmokeTest } from "@gram/agents/codex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Proc, ProcLive } from "@gram/git";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_BASELINE } from "./codex-baseline.ts";
import { codexTarget, type RuntimeArtifact } from "./gate.ts";
import { makeLeases } from "./leases.ts";
import { npmPackDownloader } from "./npm-pack.ts";
import { makeRuntimeStore } from "./store.ts";
import { install, rollback, type TransactionDeps } from "./transaction.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "gram-managed-codex-")));

/**
 * The real thing: fetches this machine's bundled-baseline Codex package with the user's own
 * `npm pack` (through whatever registry npm is configured for) into a temp store, verifies it,
 * and runs `codex --version` and an app-server handshake in an empty `CODEX_HOME`. Nothing
 * outside the temp dir is written. About 150 MB.
 */
describe.skipIf(process.env["GRAM_LIVE_CODEX_RUNTIME"] !== "1")(
  "managed Codex through npm (GRAM_LIVE_CODEX_RUNTIME=1)",
  () => {
    it("installs the bundled baseline and selects it", { timeout: 600_000 }, async () => {
      tempDir();
      const target = codexTarget();
      const artifact = CODEX_BASELINE.find((a) => a.target === target);
      expect(artifact, `no baseline package for ${target}`).toBeDefined();
      const store = makeRuntimeStore(join(dir, "agents"), "codex");
      const proc = await Effect.runPromise(Effect.provide(Proc, ProcLive));
      const deps: TransactionDeps = {
        store,
        leases: makeLeases(),
        downloader: npmPackDownloader(proc),
        smoke: (executable, version) =>
          codexSmokeTest(executable, {
            expectedVersion: version,
            env: { PATH: process.env["PATH"] ?? "" },
          }),
        context: () => ({ appVersion: "0.8.0", target, now: Date.now() }),
      };
      const exit = await Effect.runPromise(Effect.exit(install(deps, artifact!, () => {})));
      expect(exit).toMatchObject({ _tag: "Success" });
      const active = await store.readActive();
      expect(active.current?.version).toBe(artifact!.version);
      expect(await store.intact(active.current!)).toBe(true);
    });
  },
);

const integrityOf = (bytes: Buffer) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** Where an npm platform package keeps Codex's own layout. */
const ROOT = "package/vendor/x86_64-pc-windows-msvc";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));

/** A tar entry of `body` at `name`, for a package whose entrypoint is a copy of Node. */
const tarEntry = (name: string, body: Buffer, mode = 0o644): Buffer => {
  const block = Buffer.alloc(512);
  block.write(name, 0);
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write("0", 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([block, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
};

/**
 * Windows file locking, on a real Windows machine: a running `.exe` can't be deleted or replaced,
 * and antivirus or the indexer can hold a just-written file. CI's `check-windows` job can run it
 * with `GRAM_WIN_RUNTIME_E2E=1`.
 */
describe.skipIf(process.platform !== "win32" || process.env["GRAM_WIN_RUNTIME_E2E"] !== "1")(
  "managed runtime on Windows (GRAM_WIN_RUNTIME_E2E=1)",
  () => {
    it(
      "keeps a running version, retries a locked active.json, and rolls back",
      { timeout: 120_000 },
      async () => {
        tempDir();
        const node = await readFile(process.execPath);
        const packageFor = (version: string) =>
          gzipSync(
            Buffer.concat([
              tarEntry(`${ROOT}/bin/codex.exe`, node, 0o755),
              tarEntry(
                `${ROOT}/codex-package.json`,
                Buffer.from(
                  JSON.stringify({
                    layoutVersion: 1,
                    version,
                    target: "x86_64-pc-windows-msvc",
                    entrypoint: "bin/codex.exe",
                  }),
                ),
              ),
              Buffer.alloc(1024),
            ]),
          );
        const served: Record<string, Buffer> = {};
        const artifact = (version: string): RuntimeArtifact => {
          const bytes = packageFor(version);
          served[integrityOf(bytes)] = bytes;
          return {
            agent: "codex",
            version,
            target: "x86_64-pc-windows-msvc",
            npm: {
              package: "@openai/codex",
              version: `${version}-win32-x64`,
              integrity: integrityOf(bytes),
            },
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
            publishedAt: "2026-01-01T00:00:00Z",
            artifactUpdatedAt: "2026-01-01T00:00:00Z",
            source: "bundled",
          };
        };
        const store = makeRuntimeStore(join(dir, "agents"), "codex", "win32");
        const leases = makeLeases();
        const deps: TransactionDeps = {
          store,
          leases,
          downloader: {
            fetch: (wanted, into) =>
              Effect.promise(async () => {
                const bytes = served[wanted.npm.integrity]!;
                await writeFile(join(into, "codex.tgz"), bytes);
                return { path: join(into, "codex.tgz"), integrity: integrityOf(bytes) };
              }),
          },
          // The entrypoint is Node: it starts, which is what Windows locking needs.
          smoke: () => Effect.void,
          context: () => ({
            appVersion: "0.8.0",
            target: "x86_64-pc-windows-msvc",
            now: Date.now(),
          }),
        };

        expect(Exit.isSuccess(await run(install(deps, artifact("1.0.0"), () => {})))).toBe(true);
        const first = (await store.readActive()).current!;
        // A session's app-server running from 1.0.0 while two updates land.
        const release = leases.acquire(first.id);
        const child = spawn(store.executable(first), ["-e", "setTimeout(() => {}, 60000)"], {
          stdio: "ignore",
        });
        await new Promise((resolve) => child.once("spawn", resolve));
        expect(Exit.isSuccess(await run(install(deps, artifact("1.1.0"), () => {})))).toBe(true);
        expect(Exit.isSuccess(await run(install(deps, artifact("1.2.0"), () => {})))).toBe(true);
        expect(readdirSync(store.versionsDir)).toContain(first.id);

        // An open handle on active.json while the pointer is replaced, as a scanner might hold.
        const handle = openSync(join(store.dir, "active.json"), "r");
        setTimeout(() => closeSync(handle), 300);
        expect(Exit.isSuccess(await run(rollback(deps)))).toBe(true);
        expect((await store.readActive()).current?.version).toBe("1.1.0");

        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
        release();
        await store.prune(new Set([(await store.readActive()).current!.id]));
        expect(readdirSync(store.versionsDir)).not.toContain(first.id);
      },
    );
  },
);
