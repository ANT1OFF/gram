import type * as NativeFiles from "../orchestration/anchored-files.ts";
import type * as FsPromises from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AnchoredRequest, FileBoundary } from "../orchestration/anchored-files.ts";
import { dreamFileTools } from "./dream-tools.ts";

// The old pathname implementation and the directory-fd helper are both exercised at the same
// scheduling boundaries. Filesystem operations and adversarial swaps are real in either case.
const hooks = vi.hoisted(() => ({
  open: undefined as undefined | ((path: string) => void),
  write: undefined as undefined | ((path: string) => void),
  unlink: undefined as undefined | ((path: string) => void),
  native: undefined as undefined | ((q: AnchoredRequest, phase: FileBoundary) => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      hooks.open?.(String(args[0]));
      return real.open(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      hooks.write?.(String(args[0]));
      return real.writeFile(...args);
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      hooks.unlink?.(String(args[0]));
      return real.unlink(...args);
    },
  };
});
vi.mock("../orchestration/anchored-files.ts", async (importOriginal) => {
  const real = await importOriginal<typeof NativeFiles>();
  return {
    ...real,
    anchoredRequest: ((root, q, options) =>
      real.anchoredRequest(root, q, {
        ...options,
        boundary: (phase) =>
          Effect.sync(() => hooks.native?.(q, phase)).pipe(
            Effect.andThen(options?.boundary?.(phase) ?? Effect.void),
          ),
      })) as typeof real.anchoredRequest,
  };
});
const roots: string[] = [];
afterEach(() => {
  hooks.open = hooks.write = hooks.unlink = hooks.native = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "gram-dream-boundary-")));
  roots.push(root);
  const outputDir = join(root, "w1/dreams/d1");
  for (const dir of ["input", "work", "output"])
    fs.mkdirSync(join(outputDir, dir), { recursive: true });
  let status = "running";
  const thread = { role: "dream", workspaceId: "w1", checkout: { path: outputDir } };
  const store = {
    getThread: () => Effect.succeed(thread),
    listDreams: () => Effect.succeed([{ id: "d1", threadId: "t1", status, outputDir }]),
    withDreamFileCommit: <A, E>(effect: Effect.Effect<A, E>) => effect,
  };
  const definitions = dreamFileTools(store as never);
  const call = (name: string, args: Record<string, string>) =>
    Effect.runPromise(
      definitions.find((d) => d.descriptor.name === name)!.handle("t1" as never, args, {}),
    );
  return {
    root,
    outputDir,
    thread,
    call,
    cancel: () => {
      status = "canceled";
    },
  };
};

it("refuses an outside hardlink at the opened file", async () => {
  const s = setup();
  const outside = join(s.root, "outside.md");
  fs.writeFileSync(outside, "outside-only synthetic text");
  fs.linkSync(outside, join(s.outputDir, "work/linked.md"));
  await expect(s.call("dream_read", { path: "work/linked.md" })).rejects.toThrow();
});

for (const area of ["work", "input"] as const)
  it(`anchors ${area} reads through an ancestor swap`, async () => {
    const s = setup();
    const dir = join(s.outputDir, area);
    const outside = join(s.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(dir, "a.md"), "inside");
    fs.writeFileSync(join(outside, "a.md"), "outside-only synthetic text");
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      fs.renameSync(dir, `${dir}-saved`);
      fs.symlinkSync(outside, dir);
    };
    hooks.open = (p) => {
      if (p === join(dir, "a.md")) swap();
    };
    hooks.native = (q, phase) => {
      if (q.op === "read" && phase === "anchored") swap();
    };
    expect(await s.call("dream_read", { path: `${area}/a.md` })).toBe("inside");
    expect(swapped).toBe(true);
  });

it("anchors writes through an ancestor swap without touching outside", async () => {
  const s = setup();
  const work = join(s.outputDir, "work");
  const outside = join(s.root, "outside");
  fs.mkdirSync(outside);
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(work, `${work}-saved`);
    fs.symlinkSync(outside, work);
  };
  hooks.write = (p) => {
    if (p.startsWith(`${work}/.tmp-`)) swap();
  };
  hooks.native = (q, phase) => {
    if (q.op === "write" && phase === "anchored") swap();
  };
  await s.call("dream_write", { path: "work/a.md", content: "candidate" });
  expect(swapped).toBe(true);
  expect(fs.existsSync(join(outside, "a.md"))).toBe(false);
  expect(fs.readFileSync(join(`${work}-saved`, "a.md"), "utf8")).toBe("candidate");
});

it("anchors deletes through an ancestor swap without touching outside", async () => {
  const s = setup();
  const work = join(s.outputDir, "work");
  const outside = join(s.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(work, "a.md"), "inside");
  fs.writeFileSync(join(outside, "a.md"), "outside");
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(work, `${work}-saved`);
    fs.symlinkSync(outside, work);
  };
  hooks.unlink = (p) => {
    if (p === join(work, "a.md")) swap();
  };
  hooks.native = (q, phase) => {
    if (q.op === "unlink" && phase === "anchored") swap();
  };
  await s.call("dream_delete", { path: "work/a.md" });
  expect(swapped).toBe(true);
  expect(fs.readFileSync(join(outside, "a.md"), "utf8")).toBe("outside");
  expect(fs.existsSync(join(`${work}-saved`, "a.md"))).toBe(false);
});

for (const phase of ["anchored", "opened", "chunk"] as const)
  it(`bounds reads when growth occurs at ${phase}`, async () => {
    const s = setup();
    const target = join(s.outputDir, "work/a.md");
    fs.writeFileSync(target, "inside");
    let grew = false;
    const grow = () => {
      if (grew) return;
      grew = true;
      fs.appendFileSync(target, "x".repeat(2 * 1024 * 1024));
    };
    hooks.open = (p) => {
      if (p === target) grow();
    };
    hooks.native = (q, at) => {
      if (q.op === "read" && at === phase) grow();
    };
    await expect(s.call("dream_read", { path: "work/a.md" })).rejects.toThrow();
    expect(grew).toBe(true);
  });

for (const revoke of ["cancel", "rebind"] as const)
  it(`refuses a staged write after ${revoke}`, async () => {
    const s = setup();
    let revoked = false;
    const revocation = () => {
      if (revoked) return;
      revoked = true;
      if (revoke === "cancel") s.cancel();
      else s.thread.checkout.path = join(s.root, "new-binding");
    };
    hooks.write = () => revocation();
    hooks.native = (q, phase) => {
      if (q.op === "write" && phase === "staged") revocation();
    };
    await expect(s.call("dream_write", { path: "work/a.md", content: "stale" })).rejects.toThrow();
    expect(revoked).toBe(true);
    expect(fs.existsSync(join(s.outputDir, "work/a.md"))).toBe(false);
    expect(fs.readdirSync(join(s.outputDir, "work"))).toEqual([]);
  });

it("writes all replacement metacharacters literally", async () => {
  const s = setup();
  fs.writeFileSync(join(s.outputDir, "work/a.md"), "before old after");
  const replacement = "$& $` $' $$";
  await s.call("dream_edit", { path: "work/a.md", oldText: "old", newText: replacement });
  expect(fs.readFileSync(join(s.outputDir, "work/a.md"), "utf8")).toBe(
    `before ${replacement} after`,
  );
});

it("reads and searches full-depth memory snapshots relative to their root", async () => {
  const s = setup();
  fs.mkdirSync(join(s.outputDir, "input/memory/repos/gram"), { recursive: true });
  fs.writeFileSync(join(s.outputDir, "input/memory/repos/gram/notes.md"), "valid memory");
  const path = "input/memory/repos/gram/notes.md";
  expect(await s.call("dream_list", { path: "input/memory/repos/gram" })).toContainEqual({
    name: "notes.md",
    kind: "file",
  });
  expect(await s.call("dream_read", { path })).toBe("valid memory");
  expect(await s.call("dream_search", { path, text: "memory" })).toEqual([
    { line: 1, text: "valid memory" },
  ]);
  await expect(
    s.call("dream_read", { path: "input/memory/repos/gram/deeper/notes.md" }),
  ).rejects.toThrow("Path is outside");
  await expect(s.call("dream_write", { path, content: "changed" })).rejects.toThrow(
    "Path is outside",
  );
});
