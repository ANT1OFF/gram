import { isSharedPath, SHARED_ABSENT, SHARED_FILES_MAX } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planRound, type SharedBase, type SharedSide, syncRound } from "./sync.ts";
import { sharedTree, type SharedTree } from "./tree.ts";

let dir: string;
let server: SharedTree;
let host: SharedTree;

const side = (tree: SharedTree): SharedSide => tree;
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const round = (base: SharedBase) => run(syncRound(side(server), side(host), base));

const put = async (root: string, path: string, text: string, mtimeSeconds?: number) => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
  if (mtimeSeconds !== undefined) await utimes(file, mtimeSeconds, mtimeSeconds);
};
const text = (root: string, path: string) => readFile(join(root, path), "utf8");
const exists = (root: string, path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gram-shared-"));
  server = sharedTree(join(dir, "server"));
  host = sharedTree(join(dir, "host"));
  await run(server.open);
  await run(host.open);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("shared paths", () => {
  it("takes plain relative paths and refuses the rest", () => {
    expect(isSharedPath("notes/plan.md")).toBe(true);
    for (const bad of ["", "/abs", "a/../b", "./a", "a//b", ".gram-incoming/x", "a\\b", "con:"])
      expect(isSharedPath(bad), bad).toBe(false);
  });
});

describe("a sync round", () => {
  it("carries new files both ways, in folders, and agrees on them", async () => {
    await put(server.root, "notes/plan.md", "plan");
    await put(host.root, "data/out.csv", "a,b");
    const done = await round({});
    expect(done.copied).toBe(2);
    expect(await text(host.root, "notes/plan.md")).toBe("plan");
    expect(await text(server.root, "data/out.csv")).toBe("a,b");
    expect(Object.keys(done.base).toSorted()).toEqual(["data/out.csv", "notes/plan.md"]);
    const again = await round(done.base);
    expect(again.copied + again.deleted + again.deferred).toBe(0);
  });

  it("keeps the source's time, so the copy is seen as the same file", async () => {
    await put(host.root, "a.txt", "x", 1_700_000_000);
    await round({});
    expect((await stat(join(server.root, "a.txt"))).mtimeMs).toBe(1_700_000_000_000);
  });

  it("carries a change and a delete from the side that made it", async () => {
    await put(server.root, "a.txt", "one");
    await put(server.root, "b.txt", "keep");
    const first = await round({});
    await put(host.root, "a.txt", "two");
    await rm(join(server.root, "b.txt"));
    const second = await round(first.base);
    expect(await text(server.root, "a.txt")).toBe("two");
    expect(await exists(host.root, "b.txt")).toBe(false);
    expect(second.base["b.txt"]).toBeUndefined();
  });

  it("lets the later write win when both sides changed a file", async () => {
    await put(server.root, "a.txt", "base");
    const first = await round({});
    await put(server.root, "a.txt", "server", 1_800_000_000);
    await put(host.root, "a.txt", "host", 1_800_000_100);
    await round(first.base);
    expect(await text(server.root, "a.txt")).toBe("host");
    expect(await text(host.root, "a.txt")).toBe("host");
  });

  it("lets an edit beat a delete", async () => {
    await put(server.root, "a.txt", "base");
    const first = await round({});
    await rm(join(host.root, "a.txt"));
    await put(server.root, "a.txt", "edited");
    await round(first.base);
    expect(await text(host.root, "a.txt")).toBe("edited");
  });

  it("never follows a link, nor carries one", async () => {
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(host.root, "escape"));
    await put(server.root, "escape/x.txt", "nope");
    const done = await round({});
    expect(done.deferred).toBe(1);
    expect(await exists(join(dir, "outside"), "x.txt")).toBe(false);
    expect((await run(host.list)).entries).toEqual([]);
  });

  it("deletes nothing from a listing that was cut off", () => {
    const plan = planRound(
      { entries: [], held: [], complete: false },
      { entries: [{ path: "a", size: 1, mtimeMs: 1, sha256: "h" }], held: [], complete: true },
      { a: "h" },
    );
    expect(plan.steps).toEqual([]);
    expect(plan.settled).toEqual({ a: "h" });
    expect(SHARED_FILES_MAX).toBeGreaterThan(0);
  });

  it("leaves a held file alone on both sides", () => {
    const plan = planRound(
      { entries: [], held: ["big.bin"], complete: true },
      { entries: [], held: [], complete: true },
      { "big.bin": "h" },
    );
    expect(plan.steps).toEqual([]);
  });
});

describe("a shared tree's writes", () => {
  it("refuses a write when the file there changed since it was listed", async () => {
    await put(host.root, "a.txt", "theirs");
    await put(server.root, "a.txt", "mine");
    const listed = (await run(server.list)).entries[0]!;
    const read = await run(server.read("a.txt", 0, 1024));
    const placed = await run(
      host.write({
        path: "a.txt",
        offset: 0,
        data: read.data,
        size: listed.size,
        mtimeMs: listed.mtimeMs,
        sha256: listed.sha256,
        ifMatch: SHARED_ABSENT,
      }),
    );
    expect(placed.placed).toBe(false);
    expect(await text(host.root, "a.txt")).toBe("theirs");
  });

  it("writes a file in parts and puts it in place only at the end", async () => {
    const big = Buffer.alloc(9 * 2 ** 20, 7);
    await mkdir(server.root, { recursive: true });
    await writeFile(join(server.root, "big.bin"), big);
    const done = await round({});
    expect(done.copied).toBe(1);
    expect((await readFile(join(host.root, "big.bin"))).equals(big)).toBe(true);
    expect(await exists(host.root, ".gram-incoming")).toBe(true);
    expect((await run(host.list)).entries.map((e) => e.path)).toEqual(["big.bin"]);
  });
});
