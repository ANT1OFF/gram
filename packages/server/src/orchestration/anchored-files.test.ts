import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { anchoredRequest, ANCHORED_FILE_PROGRAM, withAnchoredFiles } from "./anchored-files.ts";
import type { SpawnOptions } from "node:child_process";

const processCalls = vi.hoisted(() => ({
  missing: false,
  calls: [] as unknown[][],
  children: [] as ChildProcess.ChildProcess[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  return {
    ...real,
    spawn: ((command: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      processCalls.calls.push([command, args, options]);
      const child = real.spawn(
        processCalls.missing ? "/gram-test-no-such-interpreter" : command,
        args,
        options,
      );
      processCalls.children.push(child);
      return child;
    }) as unknown as typeof real.spawn,
  };
});
const roots: string[] = [];
afterEach(() => {
  for (const child of processCalls.children.splice(0))
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  processCalls.missing = false;
  processCalls.calls.length = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
const root = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gram-fixed-file-helper-")));
  roots.push(dir);
  return dir;
};
const request = { op: "probe", workspaceId: "w1", rel: "", within: "" } as const;

it("uses only the fixed isolated interpreter and an empty environment", async () => {
  expect(await Effect.runPromise(anchoredRequest(root(), request))).toBe(true);
  expect(processCalls.calls).toHaveLength(1);
  expect(processCalls.calls[0]?.[0]).toBe("/usr/bin/python3");
  expect((processCalls.calls[0]![1] as string[]).slice(0, 4)).toEqual(["-I", "-S", "-u", "-c"]);
  expect(processCalls.calls[0]?.[2]).toMatchObject({
    cwd: "/",
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
});

it("reports a missing interpreter as unavailable without a pathname fallback", async () => {
  const dir = root();
  processCalls.missing = true;
  await expect(
    Effect.runPromise(
      anchoredRequest(dir, { ...request, op: "write", rel: "a.md", content: "candidate" }),
    ),
  ).rejects.toThrow("requires /usr/bin/python3");
  expect(fs.readdirSync(dir)).toEqual([]);
});

it("refuses unsupported platforms before launching a helper", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const dir = root();
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await expect(Effect.runPromise(anchoredRequest(dir, request))).rejects.toThrow(
      "unavailable on this platform",
    );
    expect(processCalls.calls).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("the helper independently refuses traversal, invalid operations and oversized reads", async () => {
  const dir = root();
  for (const q of [
    { ...request, op: "read" as const, rel: "../outside.md" },
    { ...request, op: "read" as const, rel: "input/a.md", within: "output" },
    { ...request, op: "read" as const, rel: "a.md", maxBytes: 4 * 1024 * 1024 + 1 },
    { ...request, op: "execute" as never },
  ])
    await expect(Effect.runPromise(anchoredRequest(dir, q))).rejects.toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it("revocation/interruption cleans its staged temp and leaves the old file intact", async () => {
  const dir = root();
  fs.mkdirSync(join(dir, "w1"));
  fs.writeFileSync(join(dir, "w1/a.md"), "old");
  const result = await Effect.runPromise(
    anchoredRequest(
      dir,
      { ...request, op: "write", rel: "a.md", content: "candidate" },
      {
        boundary: (phase) => (phase === "staged" ? Effect.interrupt : Effect.void),
      },
    ).pipe(Effect.exit),
  );
  expect(result._tag).toBe("Failure");
  expect(fs.readFileSync(join(dir, "w1/a.md"), "utf8")).toBe("old");
  expect(fs.readdirSync(join(dir, "w1"))).toEqual(["a.md"]);
});

it("shares startup across concurrent operations, retaining per-request paths and boundaries", async () => {
  const dirs = [root(), root()];
  const phases: string[] = [];
  const result = await Effect.runPromise(
    withAnchoredFiles(
      Effect.gen(function* () {
        yield* Effect.all(
          dirs.map((dir, index) =>
            anchoredRequest(
              dir,
              { ...request, op: "write", rel: "a.md", content: `${index}` },
              {
                boundary: (phase) =>
                  Effect.sync(() => {
                    phases.push(`${index}:${phase}`);
                  }),
              },
            ),
          ),
          { concurrency: "unbounded" },
        );
        // A complete refusal leaves the protocol ready for the next operation.
        yield* Effect.flip(anchoredRequest(dirs[0]!, { ...request, op: "read", rel: "missing" }));
        return yield* Effect.all(
          dirs.map((dir) => anchoredRequest<string>(dir, { ...request, op: "read", rel: "a.md" })),
          { concurrency: "unbounded" },
        );
      }),
    ),
  );
  expect(result).toEqual(["0", "1"]);
  expect(phases).toEqual([
    "0:anchored",
    "0:staged",
    "0:committing",
    "1:anchored",
    "1:staged",
    "1:committing",
  ]);
  expect(processCalls.calls).toHaveLength(1);
});

it("discards a revoked batch handshake before another operation and cleans staged files", async () => {
  const dir = root();
  fs.mkdirSync(join(dir, "w1"));
  fs.writeFileSync(join(dir, "w1/a.md"), "old");
  const result = await Effect.runPromise(
    withAnchoredFiles(
      Effect.gen(function* () {
        const exit = yield* anchoredRequest(
          dir,
          { ...request, op: "write", rel: "a.md", content: "candidate" },
          { boundary: (phase) => (phase === "staged" ? Effect.interrupt : Effect.void) },
        ).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        return yield* anchoredRequest<string>(dir, { ...request, op: "read", rel: "a.md" });
      }),
    ),
  );
  expect(result).toBe("old");
  expect(processCalls.calls).toHaveLength(2);
  expect(fs.readdirSync(join(dir, "w1"))).toEqual(["a.md"]);
});

it("reopens paths for every batched request and refuses a substituted workspace symlink", async () => {
  const dir = root();
  const outside = root();
  fs.mkdirSync(join(dir, "w1"));
  fs.writeFileSync(join(dir, "w1/a.md"), "original");
  fs.writeFileSync(join(outside, "a.md"), "outside");
  const result = await Effect.runPromise(
    withAnchoredFiles(
      Effect.gen(function* () {
        const read = anchoredRequest<string>(dir, { ...request, op: "read", rel: "a.md" });
        expect(yield* read).toBe("original");
        fs.renameSync(join(dir, "w1"), join(dir, "saved"));
        fs.symlinkSync(outside, join(dir, "w1"));
        yield* Effect.flip(read);
        fs.unlinkSync(join(dir, "w1"));
        fs.mkdirSync(join(dir, "w1"));
        fs.writeFileSync(join(dir, "w1/a.md"), "replacement");
        return yield* read;
      }),
    ),
  );
  expect(result).toBe("replacement");
  expect(fs.readFileSync(join(outside, "a.md"), "utf8")).toBe("outside");
  expect(processCalls.calls).toHaveLength(1);
});

it("opens a fresh helper for a later request after the previous helper exits by signal", async () => {
  const dir = root();
  await Effect.runPromise(
    withAnchoredFiles(
      Effect.gen(function* () {
        expect(yield* anchoredRequest(dir, request)).toBe(true);
        const child = processCalls.children.at(-1)!;
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGTERM");
        yield* Effect.promise(() => closed);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBe("SIGTERM");
        expect(yield* anchoredRequest(dir, request)).toBe(true);
      }),
    ),
  );
  expect(processCalls.calls).toHaveLength(2);
});

it("ends the helper after one oversized-line refusal without executing its remaining fragment", async () => {
  const dir = root();
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-u", "-c", ANCHORED_FILE_PROGRAM], {
    cwd: "/",
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stderr.resume();
  child.stdin.on("error", () => undefined); // EOF may arrive while the oversized write drains.
  const lines = createInterface({ input: child.stdout });
  const responses: unknown[] = [];
  const phases: string[] = [];
  const tail = JSON.stringify({
    ...request,
    root: dir,
    op: "write",
    rel: "a.md",
    content: "must not execute",
  });
  try {
    // After the first capped read, this suffix is itself valid JSON. It is still part of the
    // oversized request, never authority to start another operation.
    child.stdin.write(`${" ".repeat(32 * 1024 * 1024 + 1)}${tail}\n`);
    for await (const line of lines) {
      const response = JSON.parse(line) as { phase?: string };
      if (response.phase !== undefined) {
        phases.push(response.phase);
        child.stdin.write("continue\n");
      } else {
        responses.push(response);
        if (responses.length > 1) child.stdin.end();
      }
    }
    await closed;
    expect(responses).toEqual([{ error: "refused", message: "Request exceeds helper cap" }]);
    expect(phases).toEqual([]);
    expect(child.exitCode).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    await closed;
    lines.close();
  }
});
