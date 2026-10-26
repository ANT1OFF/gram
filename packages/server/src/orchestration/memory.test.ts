import type * as NativeFiles from "./anchored-files.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import { ServerConfig } from "../config.ts";
import { FsError } from "@gram/contracts";
import {
  appendEntry,
  checkMemorySet,
  editPassage,
  MEMORY_DIFF_MAX_BYTES,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_HISTORY_KEEP,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_TEMPLATE,
  MEMORY_MAX_FILES,
  MEMORY_VERSIONS_KEEP,
  memoryPathProblem,
  memorySnapshotDigest,
  OrchestrationMemory,
  type MemoryError,
  type OrchestrationMemoryShape,
} from "./memory.ts";

// A disk that fills up part-way through an adoption: no real filesystem fails on cue, so the one
// write whose content matches is made to. Everything else goes to the real `node:fs/promises`.
const disk = vi.hoisted(() => ({ failOnContent: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const writeFile: (typeof FsPromises)["writeFile"] = (file, data, options) =>
    disk.failOnContent !== undefined && data === disk.failOnContent
      ? Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }))
      : real.writeFile(file, data, options);
  return { ...real, writeFile };
});
vi.mock("./anchored-files.ts", async (importOriginal) => {
  const real = await importOriginal<typeof NativeFiles>();
  return {
    ...real,
    anchoredRequest: ((root, q, options) =>
      q.op === "write" && disk.failOnContent !== undefined && q.content === disk.failOnContent
        ? Effect.fail(new FsError({ path: q.rel, message: "ENOSPC: no space left on device" }))
        : real.anchoredRequest(root, q, options)) as typeof real.anchoredRequest,
  };
});

const WS = "ws-1";

/** Operations of different result types, for tests that only look at how each one fails. */
const each = (
  ...effects: ReadonlyArray<Effect.Effect<unknown, MemoryError>>
): ReadonlyArray<Effect.Effect<unknown, MemoryError>> => effects;

interface Fixture {
  readonly memory: OrchestrationMemoryShape;
  /** The folder holding one folder per workspace. */
  readonly root: string;
  /** A sibling folder outside memory, for symlinks to point at. */
  readonly outside: string;
  /** Absolute path inside the workspace's tree. */
  readonly at: (...segments: ReadonlyArray<string>) => string;
}

/** Memory in a temp dir, removed when the test's scope closes. */
const withMemory = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-orch-memory-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const root = join(dir, "orchestration");
      const outside = join(dir, "outside");
      mkdirSync(outside);
      return yield* Effect.gen(function* () {
        const memory = yield* OrchestrationMemory;
        return yield* body({
          memory,
          root,
          outside,
          at: (...segments) => join(root, WS, ...segments),
        });
      }).pipe(Effect.provide(OrchestrationMemory.layerAt(root)));
    }),
  );

const historyOf = (fixture: Fixture, key: string): ReadonlyArray<string> => {
  const dir = fixture.at("versions", "0001", ".history", key);
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
};

describe("OrchestrationMemory: layout", () => {
  it.effect("new memory is sparse and its index labels suggested files", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        expect((yield* f.memory.list(WS)).map((file) => file.path)).toEqual(["MEMORY.md"]);
        for (const path of ["goals.md", "decisions.md", "standing-decisions.md"]) {
          expect(yield* Effect.flip(f.memory.read(WS, path))).toMatchObject({
            _tag: "NotFound",
            id: path,
            message: `No memory file ${path}`,
          });
        }
        expect(yield* f.memory.index(WS)).toContain("Suggested files (created only when needed)");
        expect(yield* f.memory.index(WS)).toContain("memory_list");
      }),
    ),
  );

  it.effect("init seeds version 0001 with an index and CURRENT, and is idempotent", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        expect(readFileSync(f.at("CURRENT"), "utf8").trim()).toBe("0001");
        expect(yield* f.memory.currentVersion(WS)).toBe("0001");
        expect(yield* f.memory.root(WS)).toBe(f.at("versions", "0001"));
        expect(yield* f.memory.index(WS)).toBe(MEMORY_INDEX_TEMPLATE);
        expect(MEMORY_INDEX_TEMPLATE).toContain("Nothing derivable belongs here");

        yield* f.memory.write(WS, "MEMORY.md", "# Mine\n");
        yield* f.memory.init(WS);
        expect(yield* f.memory.index(WS)).toBe("# Mine\n");
      }),
    ),
  );

  it.effect("reopening preserves a saved index and written topics without seeding others", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const savedIndex =
          "# Memory index\n- goals.md: workspace goals\n- decisions.md: decisions\n";
        yield* f.memory.write(WS, "MEMORY.md", savedIndex);
        yield* f.memory.write(WS, "goals.md", "2026-10-18: Synthetic fixture goal (test brief).\n");
        const before = yield* f.memory.snapshot(WS);
        yield* Effect.gen(function* () {
          const reopened = yield* OrchestrationMemory;
          yield* reopened.init(WS);
          expect(yield* reopened.index(WS)).toBe(savedIndex);
          expect(yield* reopened.read(WS, "goals.md")).toBe(
            "2026-10-18: Synthetic fixture goal (test brief).\n",
          );
          expect((yield* reopened.list(WS)).map((file) => file.path)).toEqual([
            "MEMORY.md",
            "goals.md",
          ]);
          expect(yield* reopened.snapshot(WS)).toEqual(before);
        }).pipe(Effect.provide(OrchestrationMemory.layerAt(f.root)));
      }),
    ),
  );

  it.effect("init takes up the newest version again when CURRENT was lost", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        mkdirSync(f.at("versions", "0003"));
        writeFileSync(f.at("versions", "0003", "MEMORY.md"), "# Adopted\n");
        rmSync(f.at("CURRENT"));

        yield* f.memory.init(WS);
        expect(yield* f.memory.currentVersion(WS)).toBe("0003");
        expect(yield* f.memory.index(WS)).toBe("# Adopted\n");
      }),
    ),
  );

  it.effect("reads as empty before init, and says so for what needs a tree", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        expect(yield* f.memory.list(WS)).toEqual([]);
        expect(yield* f.memory.index(WS)).toBe("");
        expect(yield* Effect.flip(f.memory.read(WS, "goals.md"))).toMatchObject({
          _tag: "NotFound",
          entity: "file",
          id: "goals.md",
        });
        expect(yield* Effect.flip(f.memory.currentVersion(WS))).toMatchObject({
          _tag: "InvalidState",
        });
        expect(yield* Effect.flip(f.memory.remove(WS, "goals.md"))).toMatchObject({
          _tag: "InvalidState",
        });
        expect(existsSync(f.root)).toBe(false);
      }),
    ),
  );

  it.effect("index is empty when MEMORY.md was deleted", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        yield* f.memory.remove(WS, "MEMORY.md");
        expect(yield* f.memory.index(WS)).toBe("");
      }),
    ),
  );

  it.effect("the layer keeps memory under <dataDir>/orchestration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "gram-orch-memory-layer-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })),
        );
        const config = ServerConfig.layer({
          dataDir,
          port: 0,
          webRoot: undefined,
          extraOrigins: [],
          idleEvictAfter: undefined,
          interruptWatchdog: Duration.seconds(5),
        });
        yield* Effect.gen(function* () {
          const memory = yield* OrchestrationMemory;
          yield* memory.init(WS);
        }).pipe(Effect.provide(OrchestrationMemory.layer.pipe(Layer.provide(config))));
        expect(
          existsSync(join(dataDir, "orchestration", WS, "versions", "0001", "MEMORY.md")),
        ).toBe(true);
      }),
    ),
  );
});

describe("OrchestrationMemory: files", () => {
  it.effect("writes, reads and lists, initialising on the first write", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const created = yield* f.memory.write(WS, "repos/gram.md", "pnpm check first\n");
        expect(created).toEqual({
          path: "repos/gram.md",
          action: "write",
          after: "pnpm check first\n",
          bytes: 17,
        });
        expect(yield* f.memory.read(WS, "repos/gram.md")).toBe("pnpm check first\n");

        const changed = yield* f.memory.write(WS, "repos/gram.md", "æ\n");
        expect(changed).toEqual({
          path: "repos/gram.md",
          action: "write",
          before: "pnpm check first\n",
          after: "æ\n",
          bytes: 3,
        });

        yield* f.memory.write(WS, "goals.md", "ship P1\n");
        const files = yield* f.memory.list(WS);
        expect(files.map((file) => [file.path, file.bytes])).toEqual([
          ["MEMORY.md", Buffer.byteLength(MEMORY_INDEX_TEMPLATE)],
          ["goals.md", 8],
          ["repos/gram.md", 3],
        ]);
        expect(files.every((file) => file.modifiedAt > 0)).toBe(true);
      }),
    ),
  );

  it.effect("list leaves out history, dotfiles, other file types and temp leftovers", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "goals.md", "one\n");
        yield* f.memory.write(WS, "goals.md", "two\n");
        writeFileSync(f.at("versions", "0001", ".tmp-crashed"), "half");
        writeFileSync(f.at("versions", "0001", "notes.txt"), "by hand");
        expect((yield* f.memory.list(WS)).map((file) => file.path)).toEqual([
          "MEMORY.md",
          "goals.md",
        ]);
      }),
    ),
  );

  it.effect("remove returns what was there, keeps it in history, and then finds nothing", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "workers/t-1.md", "flaky on Windows\n");
        expect(yield* f.memory.remove(WS, "workers/t-1.md")).toEqual({
          path: "workers/t-1.md",
          action: "delete",
          before: "flaky on Windows\n",
          bytes: 0,
        });
        const kept = historyOf(f, "workers%2Ft-1.md");
        expect(kept).toHaveLength(1);
        expect(
          readFileSync(f.at("versions", "0001", ".history", "workers%2Ft-1.md", kept[0]!), "utf8"),
        ).toBe("flaky on Windows\n");
        expect(yield* Effect.flip(f.memory.remove(WS, "workers/t-1.md"))).toMatchObject({
          _tag: "NotFound",
          entity: "file",
        });
        expect(yield* Effect.flip(f.memory.read(WS, "workers/t-1.md"))).toMatchObject({
          _tag: "NotFound",
        });
      }),
    ),
  );

  it.effect("caps each side of the reported diff while the file keeps everything", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const long = "ø".repeat(10 * 1024);
        const result = yield* f.memory.write(WS, "decisions.md", long);
        expect(result.bytes).toBe(20 * 1024);
        expect(Buffer.byteLength(result.after ?? "")).toBeLessThan(MEMORY_DIFF_MAX_BYTES + 64);
        expect(result.after).toContain("[truncated: 20.0 KB in all]");
        expect(result.after).not.toContain("\uFFFD");
        expect(yield* f.memory.read(WS, "decisions.md")).toBe(long);

        const again = yield* f.memory.write(WS, "decisions.md", "short\n");
        expect(again.before).toContain("[truncated");
        expect(again.after).toBe("short\n");
      }),
    ),
  );
});

describe("memory_append and memory_edit", () => {
  it("appends an entry on lines of its own", () => {
    expect(appendEntry(undefined, "a")).toBe("a\n");
    expect(appendEntry("", "a\n")).toBe("a\n");
    expect(appendEntry("x", "a")).toBe("x\na\n");
    expect(appendEntry("x\n", "a\nb")).toBe("x\na\nb\n");
  });

  it("replaces a passage found once, or every one with replaceAll, and refuses otherwise", () => {
    expect(editPassage("a b a", { old: "b", new: "c" })).toBe("a c a");
    // `new` is text, not a replacement pattern.
    expect(editPassage("a b", { old: "b", new: "$&$&" })).toBe("a $&$&");
    expect(editPassage("a b a", { old: "a", new: "", replaceAll: true })).toBe(" b ");
    expect(editPassage("a b a", { old: "a", new: "$&$&", replaceAll: true })).toBe("$&$& b $&$&");
    expect(editPassage("a b a", { old: "a", new: "c" })).toEqual({
      problem:
        "`old` appears 2 times. Quote more of the passage so it is unique, or pass replaceAll.",
    });
    expect(editPassage("a", { old: "z", new: "c" })).toMatchObject({
      problem: expect.stringContaining("`old` isn't in the file"),
    });
    expect(editPassage(undefined, { old: "z", new: "c" })).toMatchObject({
      problem: expect.stringContaining("no such file"),
    });
  });
});

describe("OrchestrationMemory: confinement", () => {
  it("refuses every path that isn't a plain relative .md path, at most three deep", () => {
    const refused = [
      "",
      "../escape.md",
      "repos/../../escape.md",
      "/etc/passwd.md",
      "repos//x.md",
      "repos/x.md/",
      "./goals.md",
      "repos\\x.md",
      "C:\\x.md",
      "go\0als.md",
      "go\nals.md",
      ".history/goals.md/000000000000001.md",
      "repos/.history/x.md",
      ".hidden.md",
      "repos/.x.md",
      ".md",
      "notes.txt",
      "goals",
      "goals.MD",
      "a/b/c/d.md",
      "memory.md",
      "Memory.MD",
      "goals.md:stream.md",
      "what?.md",
      "nul.md",
      "COM1.md",
      "repos /x.md",
      `${"x".repeat(101)}.md`,
    ];
    for (const path of refused) expect(memoryPathProblem(path), path).toBeTypeOf("string");
    for (const path of ["MEMORY.md", "goals.md", "repos/sample_app.md", "a/b/c.md"]) {
      expect(memoryPathProblem(path), path).toBeUndefined();
    }
  });

  it.effect("a refused path touches nothing, inside memory or out", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        for (const path of [
          "../escape.md",
          "../../../outside/escape.md",
          join(f.outside, "x.md"),
        ]) {
          expect(yield* Effect.flip(f.memory.write(WS, path, "x")), path).toMatchObject({
            _tag: "InvalidState",
          });
          expect(yield* Effect.flip(f.memory.read(WS, path)), path).toMatchObject({
            _tag: "InvalidState",
          });
          expect(yield* Effect.flip(f.memory.remove(WS, path)), path).toMatchObject({
            _tag: "InvalidState",
          });
        }
        expect(readdirSync(f.outside)).toEqual([]);
        expect(readdirSync(f.at("versions"))).toEqual(["0001"]);
        expect(readdirSync(f.at("versions", "0001"))).toEqual(["MEMORY.md"]);
      }),
    ),
  );

  it.effect("a workspace id has to be one safe folder name", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        for (const id of ["", "..", "../ws", "a/b", "a\\b", ".hidden", "ws 1", "x".repeat(65)]) {
          expect(yield* Effect.flip(f.memory.init(id)), id).toMatchObject({
            _tag: "InvalidState",
          });
          expect(yield* Effect.flip(f.memory.write(id, "goals.md", "x")), id).toMatchObject({
            _tag: "InvalidState",
          });
        }
        expect(existsSync(f.root)).toBe(false);
        yield* f.memory.init("0b9f6a51-5c0e-4d2b-9a57-1f0c6c0e7a11");
      }),
    ),
  );

  it.effect("a folder where a file should be, and a file where a folder should be", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "repos/x.md", "x");
        mkdirSync(f.at("versions", "0001", "map.md"));
        expect(yield* Effect.flip(f.memory.write(WS, "map.md", "x"))).toMatchObject({
          _tag: "InvalidState",
        });
        expect(yield* Effect.flip(f.memory.read(WS, "map.md"))).toMatchObject({
          _tag: "InvalidState",
        });
        expect(yield* Effect.flip(f.memory.write(WS, "repos/x.md/y.md", "x"))).toMatchObject({
          _tag: "InvalidState",
        });
      }),
    ),
  );
});

/** Expects reading, writing and removing `path` each to be refused for passing a symlink. */
const expectRefused = (f: Fixture, path: string) =>
  Effect.gen(function* () {
    for (const effect of each(
      f.memory.read(WS, path),
      f.memory.write(WS, path, "overwritten"),
      f.memory.remove(WS, path),
    )) {
      const error = yield* Effect.flip(effect);
      expect(error).toMatchObject({ _tag: "InvalidState" });
      expect(error.message).toContain("symlink");
    }
  });

describe.skipIf(process.platform === "win32")(
  "OrchestrationMemory: symlinks (not on Windows, where making one needs a privilege)",
  () => {
    it.effect("a symlinked file is neither read, written, deleted nor listed", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.init(WS);
          const secret = join(f.outside, "secret.md");
          writeFileSync(secret, "outside");
          symlinkSync(secret, f.at("versions", "0001", "goals.md"));

          yield* expectRefused(f, "goals.md");
          expect(readFileSync(secret, "utf8")).toBe("outside");
          expect((yield* f.memory.list(WS)).map((file) => file.path)).toEqual(["MEMORY.md"]);
        }),
      ),
    );

    it.effect("a symlinked folder in the middle of the path", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.init(WS);
          writeFileSync(join(f.outside, "x.md"), "outside");
          symlinkSync(f.outside, f.at("versions", "0001", "repos"));

          yield* expectRefused(f, "repos/x.md");
          yield* expectRefused(f, "repos/new.md");
          expect(readdirSync(f.outside)).toEqual(["x.md"]);
          expect(readFileSync(join(f.outside, "x.md"), "utf8")).toBe("outside");
          expect((yield* f.memory.list(WS)).map((file) => file.path)).toEqual(["MEMORY.md"]);
        }),
      ),
    );

    it.effect("a symlinked history folder stops the write before the file changes", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.write(WS, "goals.md", "one\n");
          symlinkSync(f.outside, f.at("versions", "0001", ".history"));

          expect(yield* Effect.flip(f.memory.write(WS, "goals.md", "two\n"))).toMatchObject({
            _tag: "InvalidState",
          });
          expect(yield* f.memory.read(WS, "goals.md")).toBe("one\n");
          expect(readdirSync(f.outside)).toEqual([]);
        }),
      ),
    );

    it.effect("a symlinked versions folder", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.write(WS, "goals.md", "inside\n");
          renameSync(f.at("versions"), join(f.outside, "versions"));
          symlinkSync(join(f.outside, "versions"), f.at("versions"));

          yield* expectRefused(f, "goals.md");
          for (const effect of each(f.memory.list(WS), f.memory.index(WS), f.memory.root(WS))) {
            expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "InvalidState" });
          }
          expect(readFileSync(join(f.outside, "versions", "0001", "goals.md"), "utf8")).toBe(
            "inside\n",
          );
        }),
      ),
    );

    it.effect("a symlink swapped in for CURRENT", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.write(WS, "goals.md", "inside\n");
          const pointer = join(f.outside, "CURRENT");
          writeFileSync(pointer, "0001\n");
          rmSync(f.at("CURRENT"));
          symlinkSync(pointer, f.at("CURRENT"));

          yield* expectRefused(f, "goals.md");
          for (const effect of each(
            f.memory.init(WS),
            f.memory.currentVersion(WS),
            f.memory.list(WS),
            f.memory.index(WS),
          )) {
            expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "InvalidState" });
          }
          expect(readFileSync(pointer, "utf8")).toBe("0001\n");
        }),
      ),
    );

    it.effect("a symlinked workspace folder", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          mkdirSync(f.root);
          symlinkSync(f.outside, join(f.root, WS));

          expect(yield* Effect.flip(f.memory.init(WS))).toMatchObject({ _tag: "InvalidState" });
          expect(yield* Effect.flip(f.memory.write(WS, "goals.md", "x"))).toMatchObject({
            _tag: "InvalidState",
          });
          expect(readdirSync(f.outside)).toEqual([]);
        }),
      ),
    );
  },
);

describe("OrchestrationMemory: caps", () => {
  it.effect("the index stops at 8 KB and any file at 32 KB, with the size and a way out", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "MEMORY.md", "x".repeat(MEMORY_INDEX_MAX_BYTES));
        const index = yield* Effect.flip(
          f.memory.write(WS, "MEMORY.md", "x".repeat(MEMORY_INDEX_MAX_BYTES + 1)),
        );
        expect(index).toMatchObject({ _tag: "InvalidState" });
        expect(index.message).toContain("8193 bytes");
        expect(index.message).toContain("8.0 KB");
        expect(index.message).toContain("a dream");
        expect((yield* f.memory.index(WS)).length).toBe(MEMORY_INDEX_MAX_BYTES);

        yield* f.memory.write(WS, "map.md", "x".repeat(MEMORY_FILE_MAX_BYTES));
        const file = yield* Effect.flip(
          // Two bytes each, so the cap is on bytes and not on characters.
          f.memory.write(WS, "map.md", "ø".repeat(MEMORY_FILE_MAX_BYTES / 2 + 1)),
        );
        expect(file.message).toContain("32770 bytes");
        expect(file.message).toContain("32.0 KB");
        expect(file.message).toContain("a dream");
        expect(historyOf(f, "map.md")).toEqual([]);
      }),
    ),
  );

  it.effect("a forty-first file is refused; changing one of the forty is not", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        for (let n = 1; n < MEMORY_MAX_FILES; n++) {
          yield* f.memory.write(WS, `workers/w-${n}.md`, `${n}\n`);
        }
        expect(yield* f.memory.list(WS)).toHaveLength(MEMORY_MAX_FILES);

        const error = yield* Effect.flip(f.memory.write(WS, "one-too-many.md", "x"));
        expect(error).toMatchObject({ _tag: "InvalidState" });
        expect(error.message).toContain("40 files");
        expect(error.message).toContain("a dream");

        yield* f.memory.write(WS, "workers/w-1.md", "changed\n");
        yield* f.memory.remove(WS, "workers/w-2.md");
        yield* f.memory.write(WS, "one-too-many.md", "fits now\n");
      }),
    ),
  );
});

describe("OrchestrationMemory: scrubbing", () => {
  // Assembled at run time so the source holds nothing a secret scanner would flag.
  const githubToken = `ghp_${"a1B2".repeat(9)}`;
  const providerKey = `sk-${"ant-api03-"}${"Z9y8".repeat(6)}`;

  it.effect("token-shaped text never reaches the disk, the diff or the history", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const result = yield* f.memory.write(
          WS,
          "repos/api.md",
          `deploy with ${githubToken}\nANTHROPIC_API_KEY=${providerKey}\n`,
        );
        expect(result.after).toBe("deploy with [redacted]\nANTHROPIC_API_KEY=[redacted]\n");
        expect(result.bytes).toBe(Buffer.byteLength(result.after ?? ""));

        // A secret the user pasted in by hand is scrubbed on its way to a reader and to history.
        writeFileSync(f.at("versions", "0001", "repos", "api.md"), `by hand: ${githubToken}\n`);
        expect(yield* f.memory.read(WS, "repos/api.md")).toBe("by hand: [redacted]\n");
        const overwrite = yield* f.memory.write(WS, "repos/api.md", "clean\n");
        expect(overwrite.before).toBe("by hand: [redacted]\n");

        const everything = readdirSync(f.at(), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
          .join("\n");
        expect(everything).toContain("[redacted]");
        expect(everything).not.toContain(githubToken);
        expect(everything).not.toContain(providerKey);
      }),
    ),
  );
});

describe("OrchestrationMemory: history", () => {
  it.effect("keeps the newest twenty versions of a file and leaves no temp files", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const writes = MEMORY_HISTORY_KEEP + 6;
        for (let n = 1; n <= writes; n++) yield* f.memory.write(WS, "decisions.md", `entry ${n}\n`);

        const kept = historyOf(f, "decisions.md");
        expect(kept).toHaveLength(MEMORY_HISTORY_KEEP);
        const dir = f.at("versions", "0001", ".history", "decisions.md");
        expect(readFileSync(join(dir, kept.at(-1)!), "utf8")).toBe(`entry ${writes - 1}\n`);
        expect(readFileSync(join(dir, kept[0]!), "utf8")).toBe(
          `entry ${writes - MEMORY_HISTORY_KEEP}\n`,
        );
        expect(yield* f.memory.read(WS, "decisions.md")).toBe(`entry ${writes}\n`);

        const names = readdirSync(f.at(), { recursive: true }).map(String);
        expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
      }),
    ),
  );

  it.effect("writing the same text again is not a version", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "goals.md", "same\n");
        const again = yield* f.memory.write(WS, "goals.md", "same\n");
        expect(again).toMatchObject({ before: "same\n", after: "same\n" });
        expect(historyOf(f, "goals.md")).toEqual([]);
      }),
    ),
  );

  it.effect("files whose paths flatten alike keep separate histories", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        for (const path of ["repos/a.md", "repos%2Fa.md"]) {
          yield* f.memory.write(WS, path, `${path} one\n`);
          yield* f.memory.write(WS, path, `${path} two\n`);
        }
        expect(historyOf(f, "repos%2Fa.md")).toHaveLength(1);
        expect(historyOf(f, "repos%252Fa.md")).toHaveLength(1);
      }),
    ),
  );

  it.effect("concurrent writes of one file each leave their own history entry", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        const texts = Array.from({ length: 12 }, (_, n) => `writer ${n}\n`);
        const results = yield* Effect.forEach(
          texts,
          (text) => f.memory.write(WS, "decisions.md", text),
          { concurrency: "unbounded" },
        );

        const dir = f.at("versions", "0001", ".history", "decisions.md");
        const archived = historyOf(f, "decisions.md").map((name) =>
          readFileSync(join(dir, name), "utf8"),
        );
        const final = yield* f.memory.read(WS, "decisions.md");
        // Serialised, every text is on disk exactly once: eleven superseded, one current.
        expect([...archived, final].toSorted()).toEqual(texts.toSorted());
        expect(results.filter((result) => result.before === undefined)).toHaveLength(1);
      }),
    ),
  );
});

/** Every file and folder under the workspace, with each file's text: what "untouched" compares. */
const treeOf = (f: Fixture): ReadonlyArray<string> =>
  existsSync(f.at())
    ? readdirSync(f.at(), { recursive: true, withFileTypes: true })
        .map((entry) => {
          const path = join(entry.parentPath, entry.name);
          return entry.isFile() ? `${path}\n${readFileSync(path, "utf8")}` : path;
        })
        .toSorted()
    : [];

const big = (bytes: number) => "x".repeat(bytes);

const INDEX = { path: "MEMORY.md", content: "# Index\n" };

describe("OrchestrationMemory: adoption", () => {
  // Assembled at run time so the source holds nothing a secret scanner would flag.
  const githubToken = `ghp_${"c3D4".repeat(9)}`;

  it.effect("adopt makes the set the next version, scrubbed, and carries nothing over", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "goals.md", "one\n");
        yield* f.memory.write(WS, "goals.md", "two\n");
        expect(historyOf(f, "goals.md")).toHaveLength(1);

        const version = yield* f.memory.adopt(
          WS,
          [INDEX, { path: "repos/api.md", content: `push with ${githubToken}\n` }],
          { basedOn: "0001" },
        );
        expect(version).toBe("0002");
        expect(readFileSync(f.at("CURRENT"), "utf8")).toBe("0002\n");
        expect((yield* f.memory.list(WS)).map((file) => file.path)).toEqual([
          "MEMORY.md",
          "repos/api.md",
        ]);
        expect(readFileSync(f.at("versions", "0002", "repos", "api.md"), "utf8")).toBe(
          "push with [redacted]\n",
        );
        // The set is the version: no file and no history comes along from 0001.
        expect(yield* Effect.flip(f.memory.read(WS, "goals.md"))).toMatchObject({
          _tag: "NotFound",
        });
        expect(existsSync(f.at("versions", "0002", ".history"))).toBe(false);
        expect(yield* f.memory.readVersion(WS, "0001", "goals.md")).toBe("two\n");

        expect(yield* f.memory.versions(WS)).toMatchObject([
          { version: "0001", files: 2, current: false },
          { version: "0002", files: 2, current: true },
        ]);
        const snapshot = yield* f.memory.snapshot(WS);
        expect(snapshot.version).toBe("0002");
        expect(Object.keys(snapshot.files)).toEqual(["MEMORY.md", "repos/api.md"]);
        expect(snapshot.files["MEMORY.md"]).toEqual({
          sha256: createHash("sha256").update(INDEX.content).digest("hex"),
          bytes: INDEX.content.length,
        });
        // A live write shows up as a different hash: that is what a conflict is detected from.
        yield* f.memory.write(WS, "MEMORY.md", "# Index, edited\n");
        const after = yield* f.memory.snapshot(WS);
        expect(after.files["MEMORY.md"]?.sha256).not.toBe(snapshot.files["MEMORY.md"]?.sha256);
        expect(after.files["repos/api.md"]).toEqual(snapshot.files["repos/api.md"]);
      }),
    ),
  );

  for (const [label, before, after] of [
    ["valid replacement to invalid byte", [0xef, 0xbf, 0xbd], [0x81]],
    ["distinct invalid bytes", [0x80], [0x81]],
    ["invalid sequences with different lengths", [0x81], [0xe2, 0x82]],
    ["valid multibyte UTF-8", [0xc3, 0xa9], [0xc3, 0xa8]],
  ] as const) {
    it.effect(`raw snapshot and adoption fence distinguish ${label}`, () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.init(WS);
          const path = f.at("versions", "0001", "MEMORY.md");
          const original = Buffer.concat([
            Buffer.from("# Memory\n"),
            Buffer.from(before),
            Buffer.from("\n"),
          ]);
          const newer = Buffer.concat([
            Buffer.from("# Memory\n"),
            Buffer.from(after),
            Buffer.from("\n"),
          ]);
          writeFileSync(path, original);
          const snapshot = yield* f.memory.snapshot(WS);
          expect(snapshot.files["MEMORY.md"]).toEqual({
            sha256: createHash("sha256").update(original).digest("hex"),
            bytes: original.length,
          });
          writeFileSync(path, newer);
          const changed = yield* f.memory.snapshot(WS);
          expect(changed.files["MEMORY.md"]).toEqual({
            sha256: createHash("sha256").update(newer).digest("hex"),
            bytes: newer.length,
          });
          expect(memorySnapshotDigest(changed)).not.toBe(memorySnapshotDigest(snapshot));
          if (label !== "valid multibyte UTF-8") {
            expect(original.toString("utf8")).toBe(newer.toString("utf8"));
          }
          const result = yield* Effect.result(
            f.memory.adopt(WS, [INDEX], {
              basedOn: snapshot.version,
              basedOnDigest: memorySnapshotDigest(snapshot),
            }),
          );
          expect(result._tag).toBe("Failure");
          expect(yield* f.memory.currentVersion(WS)).toBe("0001");
          expect(readFileSync(path)).toEqual(newer);
          expect((yield* f.memory.versions(WS)).map((v) => v.version)).toEqual(["0001"]);
        }),
      ),
    );
  }

  it.effect("an import adopts into a workspace with no memory yet", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        expect(yield* f.memory.snapshot(WS)).toEqual({ version: "", files: {} });
        expect(yield* f.memory.versions(WS)).toEqual([]);
        expect(yield* f.memory.adopt(WS, [INDEX], { basedOn: "" })).toBe("0001");
        expect(yield* f.memory.index(WS)).toBe(INDEX.content);
      }),
    ),
  );

  it("checkMemorySet applies the path rules and the caps to the whole set", () => {
    const refused: ReadonlyArray<ReadonlyArray<{ path: string; content: string }>> = [
      [],
      [INDEX, { path: "../escape.md", content: "" }],
      [INDEX, { path: "caf\u00e9.md", content: "" }, { path: "cafe\u0301.md", content: "" }],
      [INDEX, { path: ".history/goals.md", content: "" }],
      [INDEX, { path: "notes.txt", content: "" }],
      [{ path: "MEMORY.md", content: big(MEMORY_INDEX_MAX_BYTES + 1) }],
      [INDEX, { path: "goals.md", content: big(MEMORY_FILE_MAX_BYTES + 1) }],
      [INDEX, { path: "goals.md", content: "" }, { path: "Goals.md", content: "" }],
      [INDEX, { path: "repos.md", content: "" }, { path: "repos.md/api.md", content: "" }],
      Array.from({ length: MEMORY_MAX_FILES + 1 }, (_, i) => ({
        path: `f${i}.md`,
        content: "",
      })),
    ];
    for (const files of refused) {
      expect(checkMemorySet(files), JSON.stringify(files).slice(0, 80)).toMatchObject({
        ok: false,
      });
    }
    // The cap is on what would be written: a secret longer than its replacement can bring a
    // file under it.
    expect(
      checkMemorySet([
        INDEX,
        { path: "goals.md", content: big(MEMORY_FILE_MAX_BYTES) },
        { path: "a/b/c.md", content: "deep\n" },
      ]),
    ).toMatchObject({ ok: true });
  });

  it.effect("a refused set, or one based on another version, leaves the tree untouched", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "goals.md", "kept\n");
        const before = treeOf(f);
        for (const effect of each(
          f.memory.adopt(WS, [INDEX, { path: "../../outside/escape.md", content: "x" }]),
          f.memory.adopt(WS, [{ path: "MEMORY.md", content: "x".repeat(9 * 1024) }]),
          f.memory.adopt(WS, []),
          f.memory.adopt(WS, [INDEX], { basedOn: "0007" }),
          f.memory.adopt(WS, [INDEX], { basedOn: "" }),
          f.memory.adopt("../ws", [INDEX]),
          f.memory.restore(WS, "../0001"),
          f.memory.readVersion(WS, "../0001", "goals.md"),
        )) {
          expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "InvalidState" });
        }
        expect(yield* Effect.flip(f.memory.restore(WS, "0002"))).toMatchObject({
          _tag: "NotFound",
        });
        expect(treeOf(f)).toEqual(before);
        expect(readdirSync(f.outside)).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the newest five besides the current, and restore points back at one", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        for (let i = 2; i <= 8; i++) {
          yield* f.memory.adopt(WS, [{ path: "MEMORY.md", content: `# v${i}\n` }]);
        }
        const kept = () => Effect.map(f.memory.versions(WS), (all) => all.map((v) => v.version));
        expect(yield* kept()).toEqual(["0003", "0004", "0005", "0006", "0007", "0008"]);
        expect(yield* kept()).toHaveLength(MEMORY_VERSIONS_KEEP + 1);

        yield* f.memory.restore(WS, "0003");
        expect(yield* f.memory.currentVersion(WS)).toBe("0003");
        expect(yield* f.memory.index(WS)).toBe("# v3\n");
        // Nothing was copied or deleted, and the next number doesn't reuse a pruned or newer one.
        expect(yield* kept()).toHaveLength(MEMORY_VERSIONS_KEEP + 1);
        expect(yield* f.memory.adopt(WS, [INDEX], { basedOn: "0003" })).toBe("0009");
        // 0003 is no longer current and is the oldest of six others.
        expect(yield* kept()).toEqual(["0004", "0005", "0006", "0007", "0008", "0009"]);
        expect(yield* Effect.flip(f.memory.restore(WS, "0003"))).toMatchObject({
          _tag: "NotFound",
        });
      }),
    ),
  );

  it.effect("a write failing part-way removes the new version and leaves CURRENT alone", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.write(WS, "goals.md", "kept\n");
        const before = treeOf(f);
        disk.failOnContent = "the disk fills up here\n";
        const error = yield* Effect.flip(
          f.memory.adopt(WS, [
            INDEX,
            { path: "repos/api.md", content: "written before the failure\n" },
            { path: "decisions.md", content: disk.failOnContent },
            { path: "questions.md", content: "never reached\n" },
          ]),
        ).pipe(Effect.ensuring(Effect.sync(() => (disk.failOnContent = undefined))));
        expect(error).toMatchObject({ _tag: "FsError" });
        expect(error.message).toContain("ENOSPC");
        expect(treeOf(f)).toEqual(before);
        expect(yield* f.memory.currentVersion(WS)).toBe("0001");
        expect(yield* f.memory.read(WS, "goals.md")).toBe("kept\n");
        // The number is free again, so the retry is 0002 rather than a gap.
        expect(yield* f.memory.adopt(WS, [INDEX])).toBe("0002");
      }),
    ),
  );

  it.effect("a live write and an adoption take turns", () =>
    withMemory((f) =>
      Effect.gen(function* () {
        yield* f.memory.init(WS);
        yield* Effect.all(
          [
            f.memory.write(WS, "goals.md", "live\n"),
            f.memory.adopt(WS, [INDEX, { path: "goals.md", content: "dreamt\n" }]),
            f.memory.write(WS, "decisions.md", "live too\n"),
          ],
          { concurrency: "unbounded" },
        );
        expect(yield* f.memory.currentVersion(WS)).toBe("0002");
        // Whichever order they ran in, each write landed whole in the version current at the time.
        expect(["live\n", "dreamt\n"]).toContain(yield* f.memory.read(WS, "goals.md"));
        expect(yield* f.memory.index(WS)).toBe(INDEX.content);
        const leftovers = treeOf(f).filter((entry) => entry.includes(".tmp-"));
        expect(leftovers).toEqual([]);
      }),
    ),
  );
});

describe.skipIf(process.platform === "win32")(
  "OrchestrationMemory: adoption against planted symlinks (creating one needs a privilege on win32)",
  () => {
    it.effect("a symlinked versions folder stops an adoption and a restore", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.init(WS);
          renameSync(f.at("versions"), join(f.outside, "versions"));
          symlinkSync(join(f.outside, "versions"), f.at("versions"));
          for (const effect of each(
            f.memory.adopt(WS, [INDEX]),
            f.memory.restore(WS, "0001"),
            f.memory.versions(WS),
            f.memory.snapshot(WS),
            f.memory.readVersion(WS, "0001", "MEMORY.md"),
          )) {
            expect(yield* Effect.flip(effect)).toMatchObject({ _tag: "InvalidState" });
          }
          expect(readdirSync(join(f.outside, "versions"))).toEqual(["0001"]);
        }),
      ),
    );

    it.effect("pruning unlinks a symlink planted in an old version without following it", () =>
      withMemory((f) =>
        Effect.gen(function* () {
          yield* f.memory.init(WS);
          writeFileSync(join(f.outside, "precious.md"), "outside\n");
          mkdirSync(join(f.outside, "folder"));
          writeFileSync(join(f.outside, "folder", "inner.md"), "outside\n");
          symlinkSync(join(f.outside, "precious.md"), f.at("versions", "0001", "link.md"));
          symlinkSync(join(f.outside, "folder"), f.at("versions", "0001", "linked"));
          for (let i = 0; i <= MEMORY_VERSIONS_KEEP; i++) yield* f.memory.adopt(WS, [INDEX]);
          expect(existsSync(f.at("versions", "0001"))).toBe(false);
          expect(readFileSync(join(f.outside, "precious.md"), "utf8")).toBe("outside\n");
          expect(readFileSync(join(f.outside, "folder", "inner.md"), "utf8")).toBe("outside\n");
        }),
      ),
    );
  },
);
