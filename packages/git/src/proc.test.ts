import * as fs from "node:fs";
import * as nodePath from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { ProcSpawnError, ProcTimeout } from "./errors.ts";
import { git } from "./exec.ts";
import { PlatformLive, Proc, ProcNonBlockingLive, runCommand } from "./proc.ts";
import { makeCommandWorker } from "./proc-worker-client.ts";
import { hasGit, removeDir, tempDir } from "./test-utils.ts";

const provide = Effect.provide(ProcNonBlockingLive);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("command worker", () => {
  it.live("reports Error and non-Error worker failures to the pending command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const thrown of ["new Error('worker failed')", "'worker failed'"]) {
          const mock = new URL(
            `data:text/javascript,${encodeURIComponent(`
              import { parentPort } from 'node:worker_threads';
              parentPort.on('message', () => { throw ${thrown}; });
            `)}`,
          );
          const run = yield* makeCommandWorker(mock);
          const error = yield* Effect.flip(run("unused", "node", [], { cwd: "." }, {}));
          expect(error).toBeInstanceOf(ProcSpawnError);
          expect(error.message).toBe("worker failed");
        }
      }),
    ),
  );

  it.live(
    "answers HTTP while native spawn waits off-CPU",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = new URL("./proc-worker.ts", import.meta.url).href;
          // Inject a held native spawn rather than a slow child: even async spawn must first return.
          const mock = new URL(
            `data:text/javascript,${encodeURIComponent(`
      import cp from 'node:child_process';
      import { parentPort } from 'node:worker_threads';
      import { syncBuiltinESMExports } from 'node:module';
      let id;
      parentPort.on('message', m => { if (m.type === 'run') id = m.id; });
      const spawn = cp.spawn;
      cp.spawn = (...args) => {
        parentPort.postMessage({type:'output', id, text:'blocking'});
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        return spawn(...args);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(source)});
    `)}`,
          );
          const run = yield* makeCommandWorker(mock);
          const server = createServer((_request, response) => response.end("alive"));
          yield* Effect.acquireRelease(
            Effect.promise(async () => {
              server.listen(0, "127.0.0.1");
              await once(server, "listening");
              return server;
            }),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("missing HTTP address");
          let markBlocking: () => void;
          const blocking = new Promise<void>((resolve) => {
            markBlocking = resolve;
          });
          let completed = false;
          const fiber = yield* run(
            process.execPath,
            "node",
            ["-e", "process.stdout.write('done')"],
            {
              cwd: ".",
              onOutput: (text) => {
                if (text === "blocking") markBlocking!();
              },
            },
            process.env as Record<string, string>,
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
            Effect.forkScoped,
          );
          yield* Effect.promise(() => blocking);
          const answer = yield* Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${address.port}`, {
              signal: AbortSignal.timeout(600),
            });
            return response.text();
          });
          expect(answer).toBe("alive");
          expect(completed).toBe(false);
          expect((yield* Fiber.join(fiber)).stdout).toBe("done");
          // Parent time includes native spawn. Cancellation must reap its eventual child.
          const overrun = yield* Effect.flip(
            run(
              process.execPath,
              "node",
              ["-e", "setInterval(() => {}, 1000)"],
              {
                cwd: ".",
                timeoutMs: 100,
              },
              process.env as Record<string, string>,
            ),
          );
          expect(overrun).toBeInstanceOf(ProcTimeout);
        }),
      ),
    10_000,
  );

  it.live(
    "preserves stdin, env, output caps, spawn errors and timeout cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Use the same default as the macOS Proc layer; Vitest also supplies __dirname for source.
          const run = yield* makeCommandWorker();
          const env = { ...process.env, WORKER_PROBE: "env" } as Record<string, string>;
          const seen: string[] = [];
          const out = yield* run(
            process.execPath,
            "node",
            [
              "-e",
              "process.stdin.on('data', x => process.stdout.write(process.env.WORKER_PROBE + x)); process.stderr.write('x'.repeat(100));",
            ],
            {
              cwd: ".",
              stdin: "input",
              maxOutputBytes: 20,
              onOutput: (text) => seen.push(text),
            },
            env,
          );
          expect(out).toEqual({
            status: 0,
            stdout: "envinput",
            stderr: "x".repeat(20),
            truncated: true,
          });
          expect(seen.join("")).toContain("envinput");
          // A predicate stays with the client, which sends the worker the env without its picks.
          const omitted = yield* run(
            process.execPath,
            "node",
            ["-e", "process.stdout.write(String(process.env.WORKER_PROBE))"],
            { cwd: ".", omitEnv: (name) => name === "WORKER_PROBE" },
            env,
          );
          expect(omitted.stdout).toBe("undefined");
          expect(
            yield* Effect.flip(run("missing-worker-bin-xyz", "missing", [], { cwd: "." }, env)),
          ).toBeInstanceOf(ProcSpawnError);
          let pid = 0;
          const error = yield* Effect.flip(
            run(
              process.execPath,
              "node",
              ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
              {
                cwd: ".",
                timeoutMs: 1000,
                onOutput: (text) => {
                  pid = Number(text.trim());
                },
              },
              env,
            ),
          );
          expect(error).toBeInstanceOf(ProcTimeout);
          expect(pid).toBeGreaterThan(0);
          expect(alive(pid)).toBe(false);
          let interruptPid = 0;
          let started: () => void;
          const ready = new Promise<void>((resolve) => {
            started = resolve;
          });
          const fiber = yield* run(
            process.execPath,
            "node",
            ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
            {
              cwd: ".",
              onOutput: (text) => {
                interruptPid = Number(text.trim());
                started!();
              },
            },
            env,
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(() => ready);
          yield* Fiber.interrupt(fiber);
          expect(alive(interruptPid)).toBe(false);
        }),
      ),
    15_000,
  );
});

describe.skipIf(process.platform === "win32")("Proc", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("captures status, stdout and stderr", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const out = yield* proc.run("sh", ["-c", "printf hi; printf oops 1>&2; exit 3"], {
        cwd: ".",
      });
      expect(out).toEqual({ status: 3, stdout: "hi", stderr: "oops", truncated: false });
    }).pipe(provide),
  );

  it.live("hands output over as it arrives, and still collects it", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const seen: Array<string> = [];
      const out = yield* proc.run(
        "sh",
        ["-c", "printf 'one\\n'; sleep 0.2; printf 'two\\n' 1>&2; printf 'ø'"],
        { cwd: ".", onOutput: (text) => seen.push(text) },
      );
      expect(seen.join("")).toContain("one\n");
      expect(seen.join("")).toContain("two\n");
      expect(seen.join("")).toContain("ø");
      expect(seen[0]).toBe("one\n");
      expect(out).toMatchObject({ status: 0, stdout: "one\nø", stderr: "two\n" });
    }).pipe(provide),
  );

  it.live("fails an overrun with a typed timeout", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const error = yield* Effect.flip(
        proc.run("sh", ["-c", "sleep 5"], { cwd: ".", timeoutMs: 80 }),
      );
      expect(error).toBeInstanceOf(ProcTimeout);
      expect(error.message).toBe("sh timed out");
    }).pipe(provide),
  );

  it.live("kills and reaps a timed-out child", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const pidFile = nodePath.join(dir, "pid");
      const proc = yield* Proc;
      const started = Date.now();
      const error = yield* Effect.flip(
        proc.run("sh", ["-c", `echo $$ > '${pidFile}' && exec sleep 30`], {
          cwd: ".",
          timeoutMs: 2_000,
        }),
      );
      expect(error).toBeInstanceOf(ProcTimeout);
      expect(Date.now() - started).toBeLessThan(10_000);
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      const deadline = Date.now() + 10_000;
      while (alive(pid) && Date.now() < deadline) yield* Effect.sleep("50 millis");
      expect(alive(pid)).toBe(false);
    }).pipe(provide),
  );

  it.live("bounds a run whose survivor holds the pipe open", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const pidFile = nodePath.join(dir, "survivor");
      const proc = yield* Proc;
      const started = Date.now();
      const error = yield* Effect.flip(
        proc.run("sh", ["-c", `sleep 20 & echo $! > '${pidFile}'; exit 0`], {
          cwd: ".",
          timeoutMs: 500,
        }),
      );
      const elapsed = Date.now() - started;
      const survivor = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      try {
        process.kill(survivor, "SIGKILL");
      } catch (cleanupError) {
        // The spawner's group cleanup may have reaped it between returning and this cleanup.
        if ((cleanupError as NodeJS.ErrnoException).code !== "ESRCH") throw cleanupError;
      }
      expect(error).toBeInstanceOf(ProcTimeout);
      // Far below the survivor's 20 s, with room for a loaded machine.
      expect(elapsed).toBeLessThan(10_000);
    }).pipe(provide),
  );

  it.live("accepts a child exiting before the termination signal", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const out = yield* runCommand(
        {
          ...spawner,
          spawn: (command) =>
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command);
              // Force the exit-before-kill ordering instead of racing a short-lived process.
              yield* handle.exitCode;
              yield* handle.kill({ forceKillAfter: "2 seconds" });
              return handle;
            }),
        },
        "sh",
        "sh",
        ["-c", "printf finished"],
        { cwd: "." },
        {},
      );
      expect(out).toEqual({ status: 0, stdout: "finished", stderr: "", truncated: false });
    }).pipe(Effect.provide(PlatformLive)),
  );

  it.live("passes env, disables terminal prompts and delivers stdin", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const env = yield* proc.run(
        "sh",
        ["-c", 'printf "%s/%s" "$CC_TEST_ENV" "$GIT_TERMINAL_PROMPT"'],
        {
          cwd: ".",
          env: { CC_TEST_ENV: "on" },
        },
      );
      expect(env.stdout).toBe("on/0");
      const cat = yield* proc.run("cat", [], { cwd: ".", stdin: "payload-on-stdin" });
      expect(cat.stdout).toBe("payload-on-stdin");
    }).pipe(provide),
  );

  it.live("leaves out inherited variables omitEnv picks, then applies env", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const names = ["GRAM_OMIT_PROBE", "GRAM_KEEP_PROBE"] as const;
      const before = names.map((name) => process.env[name]);
      process.env["GRAM_OMIT_PROBE"] = "inherited";
      process.env["GRAM_KEEP_PROBE"] = "inherited";
      // A predicate is not cloneable: it must not reach the macOS command worker as is.
      const out = yield* proc
        .run(
          "sh",
          [
            "-c",
            'printf "%s/%s/%s" "${GRAM_OMIT_PROBE-unset}" "$GRAM_KEEP_PROBE" "$GIT_TERMINAL_PROMPT"',
          ],
          {
            cwd: ".",
            omitEnv: (name) => name === "GRAM_OMIT_PROBE" || name === "GIT_TERMINAL_PROMPT",
            env: { GIT_TERMINAL_PROMPT: "0" },
          },
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() =>
              names.forEach((name, i) => {
                if (before[i] === undefined) delete process.env[name];
                else process.env[name] = before[i];
              }),
            ),
          ),
        );
      expect(out.stdout).toBe("unset/inherited/0");
    }).pipe(provide),
  );

  it.live("fails a missing binary with a spawn error", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const error = yield* Effect.flip(
        proc.run("definitely-not-a-real-binary-xyz", ["--nope"], { cwd: "." }),
      );
      expect(error).toBeInstanceOf(ProcSpawnError);
      expect(error.message).not.toBe("");
    }).pipe(provide),
  );

  it.live("caps output and keeps draining", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const out = yield* proc.run("sh", ["-c", "head -c 3000000 /dev/zero | tr '\\0' x"], {
        cwd: ".",
        maxOutputBytes: 1_000,
      });
      expect(out.status).toBe(0);
      expect(out.truncated).toBe(true);
      expect(out.stdout.length).toBe(1_000);
    }).pipe(provide),
  );

  it.live.skipIf(!hasGit)("runs git with optional locks disabled", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const out = yield* git(dir, [
        "-c",
        'alias.envprobe=!printf %s "$GIT_OPTIONAL_LOCKS"',
        "envprobe",
      ]);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe("0");
    }).pipe(provide),
  );
});

describe.skipIf(process.platform !== "win32")("Proc on Windows", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("runs a .cmd shim through cmd.exe, keeping arguments with spaces and & intact", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      // A path with a space, like `C:\Program Files\…`; `%1` keeps each argument's quotes.
      const shim = nodePath.join(dir, "claude shim.cmd");
      fs.writeFileSync(shim, "@echo off\r\necho first=[%1]\r\necho second=[%2]\r\nexit /b 7\r\n");
      const proc = yield* Proc;
      const out = yield* proc.run(shim, ["a b & c", "50%!"], { cwd: dir });
      expect(out.status).toBe(7);
      expect(out.stdout).toContain('first=["a b & c"]');
      expect(out.stdout).toContain('second=["50%!"]');
    }).pipe(provide),
  );
});
