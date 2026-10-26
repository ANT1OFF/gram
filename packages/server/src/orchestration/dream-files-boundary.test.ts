import type * as NativeFiles from "./anchored-files.ts";
import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AnchoredRequest, FileBoundary } from "./anchored-files.ts";
import { DreamFiles } from "./dream-files.ts";
import { OrchestrationMemory, confinedTree } from "./memory.ts";

const hooks = vi.hoisted(() => ({
  native: undefined as undefined | ((q: AnchoredRequest, phase: FileBoundary) => void),
  open: undefined as undefined | ((path: string) => void),
  write: undefined as undefined | ((path: string) => void),
  opened: undefined as undefined | ((handle: FsPromises.FileHandle) => Promise<void>),
}));
vi.mock("./anchored-files.ts", async (importOriginal) => {
  const real = await importOriginal<typeof NativeFiles>();
  return {
    ...real,
    anchoredRequest: ((root, q, options) =>
      real.anchoredRequest(root, q, {
        ...options,
        boundary: (phase) => Effect.sync(() => hooks.native?.(q, phase)),
      })) as typeof real.anchoredRequest,
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      hooks.open?.(String(args[0]));
      const handle = await real.open(...args);
      await hooks.opened?.(handle);
      return handle;
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      hooks.write?.(String(args[0]));
      return real.writeFile(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  hooks.native = hooks.open = hooks.write = undefined;
  hooks.opened = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
const root = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gram-dream-seams-")));
  roots.push(dir);
  return dir;
};
const run = <A, E>(dir: string, effect: Effect.Effect<A, E, DreamFiles | OrchestrationMemory>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(DreamFiles.layerAt(dir), OrchestrationMemory.layerAt(dir))),
    ),
  );
const INPUT = {
  workspaceId: "w1",
  dreamId: "dream-1234",
  memoryVersion: "0001",
  memory: [{ path: "MEMORY.md", content: "# Original\n" }],
  sessions: [],
};

for (const name of ["MEMORY.md", "REPORT.md"] as const)
  it(`refuses hardlinked ${name} during collection`, async () => {
    const dir = root();
    await run(
      dir,
      Effect.gen(function* () {
        const files = yield* DreamFiles;
        const cwd = yield* files.prepare(INPUT);
        fs.writeFileSync(join(cwd, "output/REPORT.md"), "Real report");
        const outside = join(dir, "outside.md");
        fs.writeFileSync(outside, "outside-only synthetic text");
        fs.unlinkSync(join(cwd, "output", name));
        fs.linkSync(outside, join(cwd, "output", name));
        expect(yield* Effect.flip(files.collectOutput("w1", INPUT.dreamId))).toMatchObject({
          failure: "over_caps",
        });
      }),
    );
  });

it("collection never reads outside after output's ancestor is swapped", async () => {
  const dir = root();
  await run(
    dir,
    Effect.gen(function* () {
      const files = yield* DreamFiles;
      const cwd = yield* files.prepare(INPUT);
      const output = join(cwd, "output");
      const outside = join(dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(output, "REPORT.md"), "Real report");
      fs.writeFileSync(join(outside, "MEMORY.md"), "# Outside\n");
      fs.writeFileSync(join(outside, "REPORT.md"), "Outside report");
      let swapped = false;
      let outsideOpened = false;
      const outsideInode = fs.statSync(join(outside, "MEMORY.md")).ino;
      hooks.opened = async (handle) => {
        if ((await handle.stat()).ino === outsideInode) outsideOpened = true;
      };
      const swap = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(output, `${output}-saved`);
        fs.symlinkSync(outside, output);
      };
      hooks.open = (p) => {
        if (p === join(output, "MEMORY.md")) swap();
      };
      hooks.native = (q, phase) => {
        if (q.op === "read" && q.rel.endsWith("output/MEMORY.md") && phase === "anchored") swap();
      };
      const collected = yield* Effect.result(files.collectOutput("w1", INPUT.dreamId));
      expect(swapped).toBe(true);
      // A subsequent separate operation sees the swapped symlink and refuses the proposal.
      expect(collected._tag).toBe("Failure");
      expect(outsideOpened).toBe(false);
      expect(fs.readFileSync(join(outside, "MEMORY.md"), "utf8")).toBe("# Outside\n");
    }),
  );
});

it("adoption anchors candidate copying and rollback against version ancestor swaps", async () => {
  const dir = root();
  await run(
    dir,
    Effect.gen(function* () {
      const memory = yield* OrchestrationMemory;
      yield* memory.init("w1");
      const version = join(dir, "w1/versions/0002");
      const outside = join(dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, "MEMORY.md"), "# Outside\n");
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(version, `${version}-saved`);
        fs.symlinkSync(outside, version);
      };
      hooks.write = (p) => {
        if (p.startsWith(`${version}/.tmp-`)) swap();
      };
      hooks.native = (q, phase) => {
        if (q.op === "write" && q.rel === "versions/0002/MEMORY.md" && phase === "anchored") swap();
      };
      expect(
        (yield* Effect.result(
          memory.adopt("w1", [{ path: "MEMORY.md", content: "# Candidate\n" }], {
            basedOn: "0001",
          }),
        ))._tag,
      ).toBe("Failure");
      expect(swapped).toBe(true);
      expect(fs.readFileSync(join(outside, "MEMORY.md"), "utf8")).toBe("# Outside\n");
      expect(yield* memory.currentVersion("w1")).toBe("0001");
    }),
  );
});

it("adoption anchors CURRENT's rename against a workspace ancestor swap", async () => {
  const dir = root();
  await run(
    dir,
    Effect.gen(function* () {
      const memory = yield* OrchestrationMemory;
      yield* memory.init("w1");
      const workspace = join(dir, "w1");
      const outside = join(dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, "CURRENT"), "outside-current");
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(workspace, `${workspace}-saved`);
        fs.symlinkSync(outside, workspace);
      };
      hooks.write = (p) => {
        if (p.startsWith(`${workspace}/.tmp-`)) swap();
      };
      hooks.native = (q, phase) => {
        if (q.op === "write" && q.rel === "CURRENT" && phase === "staged") swap();
      };
      expect(
        yield* memory.adopt("w1", [{ path: "MEMORY.md", content: "# Candidate\n" }], {
          basedOn: "0001",
        }),
      ).toBe("0002");
      expect(swapped).toBe(true);
      expect(fs.readFileSync(join(outside, "CURRENT"), "utf8")).toBe("outside-current");
      expect(fs.readFileSync(join(`${workspace}-saved`, "CURRENT"), "utf8")).toBe("0002\n");
    }),
  );
});

it("ordinary shared reads check the opened handle's hardlinks and growth too", async () => {
  const dir = root();
  fs.mkdirSync(join(dir, "w1"));
  const outside = join(dir, "outside.md");
  fs.writeFileSync(outside, "outside");
  fs.linkSync(outside, join(dir, "w1/a.md"));
  const tree = confinedTree(dir);
  await expect(Effect.runPromise(tree.readText("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
  fs.unlinkSync(join(dir, "w1/a.md"));
  fs.writeFileSync(join(dir, "w1/a.md"), "inside");
  hooks.open = (p) => {
    if (p === join(dir, "w1/a.md")) fs.writeFileSync(p, "x".repeat(32));
  };
  await expect(Effect.runPromise(tree.readText("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
});

it("anchored fingerprints refuse hardlinks, symlinks and opened-file growth", async () => {
  const dir = root();
  fs.mkdirSync(join(dir, "w1"));
  const path = join(dir, "w1/a.md");
  const outside = join(dir, "outside.md");
  fs.writeFileSync(outside, "outside");
  const tree = confinedTree(dir, { anchored: true });
  fs.linkSync(outside, path);
  await expect(Effect.runPromise(tree.fingerprint("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
  fs.unlinkSync(path);
  fs.symlinkSync(outside, path);
  await expect(Effect.runPromise(tree.fingerprint("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
  fs.unlinkSync(path);
  fs.writeFileSync(path, "inside");
  hooks.native = (q, phase) => {
    if (q.op === "fingerprint" && phase === "opened") fs.writeFileSync(path, "x".repeat(32));
  };
  await expect(Effect.runPromise(tree.fingerprint("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
  expect(fs.readFileSync(outside, "utf8")).toBe("outside");
});

it("anchored fingerprints hash original bytes after an ancestor swap", async () => {
  const dir = root();
  const workspace = join(dir, "w1");
  const outside = join(dir, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const original = Buffer.from([0x80]);
  const newer = Buffer.from([0xe2, 0x82]);
  fs.writeFileSync(join(workspace, "a.md"), original);
  fs.writeFileSync(join(outside, "a.md"), newer);
  let swapped = false;
  hooks.native = (q, phase) => {
    if (q.op !== "fingerprint" || phase !== "anchored" || swapped) return;
    swapped = true;
    fs.renameSync(workspace, `${workspace}-saved`);
    fs.symlinkSync(outside, workspace);
  };
  const tree = confinedTree(dir, { anchored: true });
  expect(await Effect.runPromise(tree.fingerprint("w1", "a.md", "", "a.md", 16))).toEqual({
    sha256: createHash("sha256").update(original).digest("hex"),
    bytes: original.length,
  });
  expect(swapped).toBe(true);
  await expect(Effect.runPromise(tree.fingerprint("w1", "a.md", "", "a.md", 16))).rejects.toThrow();
  expect(fs.readFileSync(join(outside, "a.md"))).toEqual(newer);
  expect(fs.readFileSync(join(`${workspace}-saved`, "a.md"))).toEqual(original);
});
