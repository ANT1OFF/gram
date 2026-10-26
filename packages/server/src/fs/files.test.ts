import { describe, expect, it } from "@effect/vitest";
import { InvalidState, NotFound } from "@gram/contracts";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hasGit, removeDir, run, tempDir } from "../git/test-repo.ts";
import { canSymlink } from "./test-symlinks.ts";
import {
  languageFor,
  listFolder,
  mentionForms,
  mentionHints,
  openOutside,
  outsideRoots,
  readFilePreview,
  readUpTo,
  resolveFileRefs,
  resolveScoped,
  resolveScopedIn,
  writesPath,
} from "./files.ts";
import { readImage } from "./images.ts";

const tempTree = Effect.acquireRelease(Effect.sync(tempDir), (dir) =>
  Effect.sync(() => removeDir(dir)),
);

const names = (listing: { readonly entries: ReadonlyArray<{ readonly name: string }> }) =>
  listing.entries.map((e) => e.name);

describe("fs.list", () => {
  it.live("sorts folders first, then natural names, and hides dotfiles unless asked", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      for (const file of ["file10.txt", "File2.txt", "b.md", ".env"]) {
        writeFileSync(join(root, file), "x");
      }
      mkdirSync(join(root, "zeta"));
      mkdirSync(join(root, "Alpha"));
      mkdirSync(join(root, ".cache"));

      const listing = yield* listFolder(root, { showHidden: false, limit: 1000 });
      expect(names(listing)).toEqual(["Alpha", "zeta", "b.md", "File2.txt", "file10.txt"]);
      expect(listing.truncated).toBe(false);
      expect(listing.parent).toBe(join(root, ".."));
      const file = listing.entries.find((e) => e.name === "b.md");
      expect(file).toMatchObject({ kind: "file", size: 1, path: join(root, "b.md") });
      expect(file?.modifiedAt).toBeGreaterThan(0);
      expect(listing.entries[0]).not.toHaveProperty("size");

      const all = yield* listFolder(root, { showHidden: true, limit: 1000 });
      expect(names(all)).toEqual([
        ".cache",
        "Alpha",
        "zeta",
        ".env",
        "b.md",
        "File2.txt",
        "file10.txt",
      ]);

      const capped = yield* listFolder(root, { showHidden: false, limit: 2 });
      expect(names(capped)).toEqual(["Alpha", "zeta"]);
      expect(capped.truncated).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live.skipIf(!hasGit)("hides git-ignored entries unless showHidden", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      run(root, "init", "-q");
      writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n");
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "app.log"), "noise");
      writeFileSync(join(root, "index.ts"), "export {}");

      expect(names(yield* listFolder(root, { showHidden: false, limit: 1000 }))).toEqual([
        "src",
        "index.ts",
      ]);
      expect(names(yield* listFolder(root, { showHidden: true, limit: 1000 }))).toEqual([
        ".git",
        "dist",
        "src",
        ".gitignore",
        "app.log",
        "index.ts",
      ]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("gives friendly errors for a missing path or a file", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      writeFileSync(join(root, "real.txt"), "x");
      const missing = join(root, "gone");
      expect(
        yield* listFolder(missing, { showHidden: false, limit: 10 }).pipe(Effect.flip),
      ).toEqual(new NotFound({ entity: "file", id: missing, message: `Not found: ${missing}` }));
      const file = join(root, "real.txt");
      expect(yield* listFolder(file, { showHidden: false, limit: 10 }).pipe(Effect.flip)).toEqual(
        new InvalidState({ message: `Not a folder: ${file}` }),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live.skipIf(!canSymlink)("reports symlinks (creating one needs a privilege on win32)", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      writeFileSync(join(root, "real.txt"), "x");
      symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
      const listing = yield* listFolder(root, { showHidden: false, limit: 1000 });
      expect(listing.entries.find((e) => e.name === "link.txt")?.kind).toBe("symlink");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});

const refusal = (attempt: string) =>
  new InvalidState({ message: `${attempt} is outside this thread's folder` });

describe("path scoping", () => {
  const checkout = Effect.gen(function* () {
    const base = yield* tempTree;
    const root = join(base, "checkout");
    const outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside);
    return { root, outside };
  });

  it.live("resolves inside a checkout and refuses escapes", () =>
    Effect.gen(function* () {
      const { root, outside } = yield* checkout;
      expect(yield* resolveScoped("src", root)).toBe(join(root, "src"));
      expect(yield* resolveScoped(".", root)).toBe(root);
      expect(yield* resolveScoped(join(root, "src"), root)).toBe(join(root, "src"));

      for (const attempt of ["../outside", outside, "src/../../outside"]) {
        expect(yield* resolveScoped(attempt, root).pipe(Effect.flip)).toEqual(refusal(attempt));
      }
      expect(yield* resolveScoped("../missing-sibling", root).pipe(Effect.flip)).toBeInstanceOf(
        InvalidState,
      );
      expect(yield* resolveScoped("src/nope", root).pipe(Effect.flip)).toBeInstanceOf(NotFound);

      expect(yield* resolveScoped(outside, undefined)).toBe(outside);
      expect(yield* resolveScoped("relative/path", undefined).pipe(Effect.flip)).toEqual(
        new InvalidState({ message: "Use an absolute path: relative/path" }),
      );
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canSymlink)(
    "follows a symlink that stays inside and refuses one that leads out (creating one needs a privilege on win32)",
    () =>
      Effect.gen(function* () {
        const { root, outside } = yield* checkout;
        symlinkSync(outside, join(root, "escape"));
        symlinkSync(join(root, "src"), join(root, "inner"));
        expect(yield* resolveScoped("inner", root)).toBe(join(root, "inner"));
        expect(yield* resolveScoped("escape", root).pipe(Effect.flip)).toEqual(refusal("escape"));
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canSymlink)(
    "places an absolute path by where it really is when a root is opened through a link",
    () =>
      Effect.gen(function* () {
        const { root, outside } = yield* checkout;
        writeFileSync(join(root, "note.txt"), "x");
        writeFileSync(join(outside, "secret.txt"), "x");
        const alias = join(dirname(root), "alias");
        symlinkSync(root, alias);
        symlinkSync(outside, join(root, "escape"));
        // The real path of a file in the folder, asked of the folder opened through `alias`.
        expect(yield* resolveScoped(join(root, "note.txt"), alias)).toBe(join(root, "note.txt"));
        expect(yield* resolveScopedIn(join(root, "note.txt"), [alias])).toBe(
          join(root, "note.txt"),
        );
        // And the other way round: the link's spelling, asked of the real folder.
        expect(yield* resolveScoped(join(alias, "note.txt"), root)).toBe(join(alias, "note.txt"));
        expect(
          yield* resolveScoped(join(root, "src/nope"), alias).pipe(Effect.flip),
        ).toBeInstanceOf(NotFound);
        // A link out is still out, through either spelling, whether or not what it names exists.
        for (const attempt of [
          join(root, "escape/secret.txt"),
          join(alias, "escape/secret.txt"),
          join(alias, "escape/missing.txt"),
          join(outside, "secret.txt"),
          join(outside, "missing.txt"),
        ]) {
          expect(yield* resolveScopedIn(attempt, [alias]).pipe(Effect.flip)).toEqual(
            refusal(attempt),
          );
        }
        expect(yield* resolveScopedIn("escape/secret.txt", [alias]).pipe(Effect.flip)).toEqual(
          refusal("escape/secret.txt"),
        );
        expect(yield* resolveScopedIn(join(root, "note.txt"), []).pipe(Effect.flip)).toEqual(
          refusal(join(root, "note.txt")),
        );
        expect(yield* outsideRoots(join(root, "note.txt"), [alias])).toBe(false);
        expect(yield* outsideRoots(join(root, "src/missing.txt"), [alias])).toBe(false);
        expect(yield* outsideRoots(join(outside, "secret.txt"), [alias])).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(!canSymlink)(
    "picks the root that really holds an absolute path, not the first one, among several",
    () =>
      Effect.gen(function* () {
        const { root, outside } = yield* checkout;
        writeFileSync(join(outside, "b.txt"), "x");
        const alias = join(dirname(root), "outside-alias");
        symlinkSync(outside, alias);
        expect(yield* resolveScopedIn(join(outside, "b.txt"), [root, alias])).toBe(
          join(outside, "b.txt"),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "takes macOS /tmp and /private/tmp for one folder",
    () =>
      Effect.gen(function* () {
        const short = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync("/tmp/gram-scope-")),
          (dir) => Effect.sync(() => removeDir(dir)),
        );
        const root = realpathSync.native(short);
        expect(root).toBe(`/private${short}`);
        writeFileSync(join(root, "note.txt"), "x");
        expect(yield* resolveScopedIn(join(root, "note.txt"), [short])).toBe(
          join(root, "note.txt"),
        );
        expect(yield* resolveScopedIn(join(short, "note.txt"), [root])).toBe(
          join(short, "note.txt"),
        );
      }).pipe(Effect.scoped),
  );
});

const resolvedOf = (files: ReadonlyArray<{ path: string; resolved: string }>) =>
  Object.fromEntries(files.map((file) => [file.path, file.resolved]));

describe("fs.resolve", () => {
  const roots = Effect.gen(function* () {
    const base = yield* tempTree;
    const checkout = join(base, "checkout");
    const other = join(base, "other");
    const outside = join(base, "outside");
    for (const dir of ["src/deep", "src/x", "src/y", "docs"]) {
      mkdirSync(join(checkout, dir), { recursive: true });
    }
    mkdirSync(join(other, "lib"), { recursive: true });
    mkdirSync(outside);
    for (const file of ["src/a.ts", "src/deep/unique.ts", "src/x/dup.ts", "src/y/dup.ts"]) {
      writeFileSync(join(checkout, file), "x");
    }
    writeFileSync(join(checkout, "docs/My Notes.md"), "x");
    // At the root and deeper: a bare `shadowed.ts` could mean either.
    writeFileSync(join(checkout, "shadowed.ts"), "x");
    writeFileSync(join(checkout, "src/deep/shadowed.ts"), "x");
    writeFileSync(join(checkout, "both.ts"), "x");
    writeFileSync(join(other, "both.ts"), "x");
    writeFileSync(join(other, "lib/b.ts"), "x");
    writeFileSync(join(outside, "secret.ts"), "x");
    return { checkout, other, outside };
  });

  it.live("links a file one root has, by path or by a name found once", () =>
    Effect.gen(function* () {
      const { checkout, other } = yield* roots;
      const paths = [
        "src/a.ts",
        "./src/a.ts",
        join(checkout, "src/a.ts"),
        "lib/b.ts",
        join(other, "lib/b.ts"),
        "docs/My Notes.md",
        "unique.ts",
      ];
      expect(resolvedOf(yield* resolveFileRefs(paths, [checkout, other]))).toEqual({
        "src/a.ts": join(checkout, "src/a.ts"),
        "./src/a.ts": join(checkout, "src/a.ts"),
        [join(checkout, "src/a.ts")]: join(checkout, "src/a.ts"),
        "lib/b.ts": join(other, "lib/b.ts"),
        [join(other, "lib/b.ts")]: join(other, "lib/b.ts"),
        "docs/My Notes.md": join(checkout, "docs/My Notes.md"),
        "unique.ts": join(checkout, "src/deep/unique.ts"),
      });
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("leaves out folders, missing files, ambiguous names and relative escapes", () =>
    Effect.gen(function* () {
      const { checkout, other, outside } = yield* roots;
      const paths = [
        "src",
        "missing.ts",
        "src/missing.ts",
        "both.ts",
        "dup.ts",
        "shadowed.ts",
        "../outside/secret.ts",
        "src/../../outside/secret.ts",
        "secret.ts",
        outside,
        join(outside, "missing.ts"),
      ];
      expect(yield* resolveFileRefs(paths, [checkout, other])).toEqual([]);
      expect(yield* resolveFileRefs(["src/a.ts"], [])).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("checks an absolute path in no root for being a file only when the thread wrote it", () =>
    Effect.gen(function* () {
      const { checkout, outside } = yield* roots;
      const secret = join(outside, "secret.ts");
      const dotted = join(checkout, "..", "outside", "secret.ts");
      const written = (path: string) => Effect.succeed(path === secret || path === dotted);
      expect(resolvedOf(yield* resolveFileRefs([secret, dotted], [checkout], written))).toEqual({
        [secret]: secret,
        [dotted]: secret,
      });
      expect(resolvedOf(yield* resolveFileRefs([secret], [], written))).toEqual({
        [secret]: secret,
      });
      expect(yield* resolveFileRefs([secret, dotted], [checkout])).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live.skipIf(!canSymlink)(
    "follows a symlink that stays inside and never one that leads out (creating one needs a privilege on win32)",
    () =>
      Effect.gen(function* () {
        const { checkout, outside } = yield* roots;
        symlinkSync(join(outside, "secret.ts"), join(checkout, "secret-link.ts"));
        symlinkSync(outside, join(checkout, "escape"));
        symlinkSync(join(checkout, "src"), join(checkout, "inner"));
        const paths = ["secret-link.ts", "escape/secret.ts", "inner/a.ts", "secret.ts"];
        expect(resolvedOf(yield* resolveFileRefs(paths, [checkout]))).toEqual({
          "inner/a.ts": join(checkout, "inner/a.ts"),
        });
        // A checkout opened through a link links its files' real paths, and still not a way out.
        const alias = join(dirname(checkout), "checkout-alias");
        symlinkSync(checkout, alias);
        const real = [join(checkout, "src/a.ts"), join(checkout, "escape/secret.ts")];
        expect(resolvedOf(yield* resolveFileRefs(real, [alias]))).toEqual({
          [join(checkout, "src/a.ts")]: join(checkout, "src/a.ts"),
        });
      }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("scopes a relative path to the first root and an absolute one to its own", () =>
    Effect.gen(function* () {
      const { checkout, other, outside } = yield* roots;
      expect(yield* resolveScopedIn("src/a.ts", [checkout, other])).toBe(
        join(checkout, "src/a.ts"),
      );
      expect(yield* resolveScopedIn(join(other, "lib/b.ts"), [checkout, other])).toBe(
        join(other, "lib/b.ts"),
      );
      const secret = join(outside, "secret.ts");
      expect(yield* resolveScopedIn(secret, [checkout, other]).pipe(Effect.flip)).toEqual(
        refusal(secret),
      );
      expect(yield* resolveScopedIn(secret, []).pipe(Effect.flip)).toEqual(refusal(secret));
    }).pipe(Effect.scoped),
  );
});

/** Whether `text` writes `path` in any of its forms, as the handlers ask. */
const linked = (text: string, path: string) => writesPath(text, mentionForms(path));

describe("transcript mentions", () => {
  it("finds a path the renderer links, position dropped", () => {
    for (const text of [
      "Wrote /tmp/r/REPORT.md.",
      "See `/tmp/r/REPORT.md:12`",
      "(/tmp/r/REPORT.md)",
      "[report](file:///tmp/r/REPORT.md#L3)",
      "[report](/tmp/r/REPORT.md#L3-L9)",
      "/tmp/r/REPORT.md",
    ]) {
      expect(linked(text, "/tmp/r/REPORT.md"), text).toBe(true);
    }
  });

  it("never finds one inside a longer path, or one the renderer doesn't link", () => {
    for (const text of [
      "/x/tmp/r/REPORT.md",
      "~/tmp/r/REPORT.md",
      "/tmp/r/REPORT.md.bak",
      "/tmp/r/REPORT.mdx",
      "/tmp/r/REPORT.md/inner",
      "/tmp/r/REPORT.md#backup",
      "`[backup](/tmp/r/REPORT.md)`",
      "file:///tmp/r/REPORT.md",
      "```\n/tmp/r/REPORT.md\n```",
      "nothing here",
    ]) {
      expect(linked(text, "/tmp/r/REPORT.md"), text).toBe(false);
    }
    expect(writesPath("see /etc/passwd", [])).toBe(false);
  });

  it("reads a link target decoded, with the renderer's positions and nothing else", () => {
    expect(linked("[notes](file:///tmp/My%20Notes.md#L2)", "/tmp/My Notes.md")).toBe(true);
    expect(linked("[notes](file:///tmp/My%20Notes.md:3)", "/tmp/My Notes.md")).toBe(true);
    expect(linked("[n](file:///tmp/a%26b.md)", "/tmp/a&b.md")).toBe(true);
    expect(linked("[n](/tmp/%E6%97%A5%E6%9C%AC.md)", "/tmp/日本.md")).toBe(true);
    expect(linked("<file:///tmp/My%20Notes.md>", "/tmp/My Notes.md")).toBe(true);
    expect(linked("[b](file:///tmp/My%20Notes.md%23backup)", "/tmp/My Notes.md")).toBe(false);
    expect(linked("[b](file:///tmp/My%20Notes.md%2Ebak)", "/tmp/My Notes.md")).toBe(false);
    expect(linked("[b](file:///tmp/a.md%2Ebak)", "/tmp/a.md")).toBe(false);
    expect(linked("[n](file:///tmp/My%20Other.md)", "/tmp/My Notes.md")).toBe(false);
    expect(linked("[n](https://organization.example.invalid/tmp/a.md)", "/tmp/a.md")).toBe(false);
  });

  it("finds every message a link could encode the path in", () => {
    expect(mentionHints(mentionForms("/tmp/a.md"))).toEqual(
      expect.arrayContaining(["%", "\\", "a.md"]),
    );
    expect(mentionHints([])).toEqual([]);
    expect(linked("[n](file:///tmp/a%2Emd)", "/tmp/a.md")).toBe(true);
    // `fs.resolve` answers with the path collapsed, and the preview asks for that.
    expect(linked("`/tmp/r/./a.md`", "/tmp/r/a.md")).toBe(true);
    expect(linked("`/tmp/r//a.md`", "/tmp/r/a.md")).toBe(true);
    expect(linked("`/tmp/r/./a.md`", "/tmp/r/b.md")).toBe(false);
    expect(linked("`/tmp/a.md<!--backup-->`", "/tmp/a.md")).toBe(false);
  });

  it("knows a home path by its ~ form too", () => {
    const home = resolve("/home/me");
    expect(mentionForms("~/notes/a.md", home)).toEqual(
      expect.arrayContaining(["~/notes/a.md", join(home, "notes", "a.md")]),
    );
    expect(mentionForms(join(home, "notes", "a.md"), home)).toEqual(
      expect.arrayContaining(["~/notes/a.md"]),
    );
  });
});

describe("fs.file", () => {
  it.live("previews text with a language, and withholds binary and oversized content", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const text = join(root, "app.ts");
      writeFileSync(text, "export const x = 1;\n");
      expect(yield* readFilePreview(text, 512 * 1024)).toEqual({
        path: text,
        size: 20,
        binary: false,
        tooLarge: false,
        language: "typescript",
        content: "export const x = 1;\n",
      });

      const large = join(root, "big.md");
      writeFileSync(large, "x".repeat(2048));
      expect(yield* readFilePreview(large, 1024)).toEqual({
        path: large,
        size: 2048,
        binary: false,
        tooLarge: true,
        language: "markdown",
      });

      const binary = join(root, "blob.bin");
      writeFileSync(binary, Buffer.from([0x89, 0x50, 0x00, 0x47]));
      expect(yield* readFilePreview(binary, 512 * 1024)).toEqual({
        path: binary,
        size: 4,
        binary: true,
        tooLarge: false,
      });

      const plain = join(root, "notes");
      writeFileSync(plain, "no extension");
      expect(yield* readFilePreview(plain, 512 * 1024)).not.toHaveProperty("language");

      const missing = join(root, "gone.ts");
      expect(yield* readFilePreview(missing, 10).pipe(Effect.flip)).toEqual(
        new NotFound({ entity: "file", id: missing, message: `Not found: ${missing}` }),
      );
      expect(yield* readFilePreview(root, 10).pipe(Effect.flip)).toEqual(
        new InvalidState({ message: `Is a folder: ${root}` }),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "opens a file outside the checkouts by its real path, never a credential file or one a link leads to",
    () =>
      Effect.gen(function* () {
        const root = yield* tempTree;
        const env = join(root, ".env");
        const notes = join(root, "notes.md");
        writeFileSync(env, "TOKEN=x\n");
        writeFileSync(notes, "# notes\n");
        const handle = yield* openOutside(notes);
        expect(yield* readFilePreview(notes, 1024, handle)).toMatchObject({
          path: notes,
          content: "# notes\n",
        });
        expect(yield* openOutside(join(root, "missing.md")).pipe(Effect.flip)).toBeInstanceOf(
          NotFound,
        );
        // The caller's own rule is asked about the real path, the one then opened.
        const asked: string[] = [];
        const refused = openOutside(notes, {}, (real) => {
          asked.push(real);
          return false;
        });
        expect(yield* refused.pipe(Effect.flip)).toBeInstanceOf(InvalidState);
        expect(asked).toEqual([realpathSync(notes)]);
        expect(yield* openOutside(env).pipe(Effect.flip)).toEqual(
          new InvalidState({
            message: `Gram doesn't preview files that may hold credentials: ${env}`,
          }),
        );
        if (!canSymlink) return;
        const link = join(root, "harmless.txt");
        symlinkSync(env, link);
        expect(yield* openOutside(link).pipe(Effect.flip)).toBeInstanceOf(InvalidState);
        // The link is read through its target, opened once: retargeting it afterwards changes nothing.
        const alias = join(root, "alias.md");
        symlinkSync(notes, alias);
        const opened = yield* openOutside(alias);
        rmSync(alias);
        symlinkSync(env, alias);
        expect(yield* readFilePreview(alias, 1024, opened)).toMatchObject({ content: "# notes\n" });

        // A folder on the way swapped for a link to Codex's after the check, and back after the
        // open: the open reached `auth.json` there, whose identity isn't the one checked.
        const codex = join(root, ".codex");
        const research = join(root, "research");
        const parked = join(root, "research-parked");
        mkdirSync(codex);
        mkdirSync(research);
        writeFileSync(join(codex, "auth.json"), '{"key":"secret"}');
        writeFileSync(join(research, "auth.json"), "{}");
        const swapped = yield* openOutside(join(research, "auth.json"), {
          checked: async () => {
            renameSync(research, parked);
            symlinkSync(codex, research);
          },
          opened: async () => {
            rmSync(research);
            renameSync(parked, research);
          },
        }).pipe(Effect.flip);
        expect(swapped).toEqual(
          new InvalidState({
            message: `${join(research, "auth.json")} changed while it was opened`,
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reads no more than the limit when a file grows after its size is taken", () =>
    Effect.gen(function* () {
      const grown = Buffer.from("0123456789");
      // `stat` says 3 bytes; the file has grown to 10 by the time it's read.
      const handle = {
        stat: async () => ({ size: 3, isDirectory: () => false }),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytesRead = grown.copy(buffer, offset, position, position + length);
          return { bytesRead, buffer };
        },
      } as unknown as FileHandle;
      expect(yield* readFilePreview("/tmp/report.md", 4, handle)).toEqual({
        path: "/tmp/report.md",
        size: 5,
        binary: false,
        tooLarge: true,
        language: "markdown",
      });
      expect(yield* readFilePreview("/tmp/report.md", 64, handle)).toMatchObject({
        size: 10,
        tooLarge: false,
        content: "0123456789",
      });
      // A huge limit on a small file allocates only what the file holds.
      const all = yield* Effect.promise(() => readUpTo(handle, 2 ** 31 - 1));
      expect(all.toString()).toBe("0123456789");
      expect(yield* readImage("/tmp/shot.png", 4, handle)).toEqual({
        path: "/tmp/shot.png",
        mediaType: "image/png",
        size: 5,
        tooLarge: true,
      });
    }),
  );

  it("detects languages from names and extensions", () => {
    expect(languageFor("/x/Dockerfile")).toBe("dockerfile");
    expect(languageFor("/x/Makefile")).toBe("makefile");
    expect(languageFor("/x/App.TSX")).toBe("tsx");
    expect(languageFor("/x/config.yml")).toBe("yaml");
    expect(languageFor("/x/script.sh")).toBe("shellscript");
    expect(languageFor("/x/main.rs")).toBe("rust");
    expect(languageFor("/x/unknown.xyz")).toBeUndefined();
    expect(languageFor("/x/.env")).toBeUndefined();
  });
});
