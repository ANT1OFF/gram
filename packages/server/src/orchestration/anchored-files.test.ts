import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchoredRequest } from "./anchored-files.ts";
import type { SpawnOptions } from "node:child_process";

const processCalls = vi.hoisted(() => ({ missing: false, calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  return {
    ...real,
    spawn: ((command: string, args: ReadonlyArray<string>, options: SpawnOptions) => {
      processCalls.calls.push([command, args, options]);
      return real.spawn(
        processCalls.missing ? "/gram-test-no-such-interpreter" : command,
        args,
        options,
      );
    }) as unknown as typeof real.spawn,
  };
});
const roots: string[] = [];
afterEach(() => {
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
