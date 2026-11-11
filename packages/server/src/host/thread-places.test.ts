// A machine's places for threads started from a profile, on a real disk and real git: what the
// host makes and writes, and what it refuses whatever the control plane asked for.
import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import { Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasGit, makeRepo } from "../git/test-repo.ts";
import { foldersOn } from "./folders.ts";
import { HOST_THREADS_DIR, threadPlacesOnHost } from "./thread-places.ts";

const THREAD = "0d9f2c1e-4b7a-4c55-9a53-1f2e3d4c5b6a" as ThreadId;

/** A machine's home with the host's own folder and its clones in it, as `gram-host` lays them. */
const machine = () =>
  Effect.gen(function* () {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "gram-thread-places-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(home, { recursive: true, force: true })),
    );
    const hostHome = join(home, ".config", "gram-host");
    const clones = join(hostHome, "repos");
    mkdirSync(clones, { recursive: true });
    const proc = yield* Proc;
    return {
      home,
      clones,
      places: threadPlacesOnHost(proc, clones),
      folders: foldersOn(proc, { home, hostHome, hostRepos: clones, agentHomes: [] }),
    };
  });

describe("a machine's places for profile threads", () => {
  it.live("makes a thread's own folder with its files, once, where a session may open", () =>
    Effect.gen(function* () {
      const { clones, places, folders } = yield* machine();
      const { path } = yield* places.make(THREAD, [
        { path: "AGENTS.md", content: "# House rules\n" },
        { path: ".claude/skills/changelog/SKILL.md", content: "Draft.\n" },
      ]);
      expect(path).toBe(join(clones, HOST_THREADS_DIR, THREAD));
      expect(readFileSync(join(path, "AGENTS.md"), "utf8")).toBe("# House rules\n");
      expect(readFileSync(join(path, ".claude/skills/changelog/SKILL.md"), "utf8")).toBe(
        "Draft.\n",
      );
      // The gate every session on the machine passes lets one open there, and nothing else.
      expect((yield* folders.gate.admit(path, "session")).path).toBe(path);
      const chat = yield* folders.gate.admit(path, "run").pipe(Effect.flip);
      expect(chat.message).toContain("Gram Host's own folder");

      // A second start under the same id never writes into the first one's folder.
      const again = yield* places
        .make(THREAD, [{ path: "AGENTS.md", content: "other\n" }])
        .pipe(Effect.flip);
      expect(again.message).toContain("already has a folder");
      expect(readFileSync(join(path, "AGENTS.md"), "utf8")).toBe("# House rules\n");

      yield* places.remove(THREAD);
      expect(existsSync(path)).toBe(false);
      // Removing what isn't there, or an id that is no id, does nothing.
      yield* places.remove(THREAD);
      yield* places.remove("../repos" as ThreadId);
      expect(existsSync(clones)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live("checks the id and every path itself, and leaves nothing of a refused start", () =>
    Effect.gen(function* () {
      const { home, clones, places } = yield* machine();
      const id = yield* places.make("../../escape" as ThreadId, []).pipe(Effect.flip);
      expect(id.message).toContain("Not a thread id");
      for (const path of ["../outside.txt", "/etc/passwd", "a/../../b", ".git/hooks/pre-commit"]) {
        const refused = yield* places.make(THREAD, [{ path, content: "x" }]).pipe(Effect.flip);
        expect(refused._tag, path).toBe("InvalidState");
      }
      const twice = yield* places
        .make(THREAD, [
          { path: "Notes.md", content: "a" },
          { path: "notes.md", content: "b" },
        ])
        .pipe(Effect.flip);
      expect(twice.message).toContain("share a path");
      const large = yield* places
        .make(THREAD, [{ path: "big.txt", content: "x".repeat(1_000_001) }])
        .pipe(Effect.flip);
      expect(large.message).toContain("at most");
      expect(existsSync(join(clones, HOST_THREADS_DIR, THREAD))).toBe(false);
      expect(existsSync(join(home, "outside.txt"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.live.skipIf(!hasGit)(
    "lays files only in a worktree of its clones, never over the repository's own",
    () =>
      Effect.gen(function* () {
        const { home, clones, places } = yield* machine();
        const clone = makeRepo(join(clones, "git.example.test", "acme", "widgets"));
        const worktree = join(clone, ".worktrees", "thread-0d9f2c1e");
        execFileSync("git", [
          "-C",
          clone,
          "worktree",
          "add",
          "--quiet",
          "-b",
          "thread/x",
          worktree,
        ]);
        writeFileSync(join(worktree, "AGENTS.md"), "the repository's own\n");

        const { laid } = yield* places.lay(worktree, [
          { path: "AGENTS.md", content: "the profile's\n" },
          { path: ".claude/skills/changelog/SKILL.md", content: "Draft.\n" },
        ]);
        expect(laid).toEqual([".claude/skills/changelog/SKILL.md"]);
        expect(readFileSync(join(worktree, "AGENTS.md"), "utf8")).toBe("the repository's own\n");
        // What was laid stays out of the thread's status, so out of its commits.
        const status = execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
          encoding: "utf8",
        });
        expect(status).not.toContain(".claude");

        // Anywhere else on the machine is refused, however the path gets there.
        const outside = join(home, "elsewhere");
        mkdirSync(outside);
        symlinkSync(outside, join(clone, "link"));
        mkdirSync(join(clones, HOST_THREADS_DIR, "other"), { recursive: true });
        for (const path of [
          outside,
          home,
          clones,
          join(clone, "link"),
          join(clones, HOST_THREADS_DIR, "other"),
          join(home, "nothing-here"),
        ]) {
          const refused = yield* places
            .lay(path, [{ path: "planted.txt", content: "x" }])
            .pipe(Effect.flip);
          expect(refused._tag, path).toBe("InvalidState");
        }
        expect(existsSync(join(outside, "planted.txt"))).toBe(false);
        expect(existsSync(join(clones, "planted.txt"))).toBe(false);
        // Nor through a link inside the worktree that leads out of it.
        symlinkSync(outside, join(worktree, "out"));
        const through = yield* places
          .lay(worktree, [{ path: "out/planted.txt", content: "x" }])
          .pipe(Effect.flip);
        expect(through.message).toContain("ELINK");
        expect(existsSync(join(outside, "planted.txt"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});
