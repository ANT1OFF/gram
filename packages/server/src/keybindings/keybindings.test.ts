import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KEYBINDINGS_ERROR_FILE,
  KEYBINDINGS_FILE,
  KEYBINDINGS_LAST_GOOD_FILE,
  KEYBINDINGS_SCHEMA_FILE,
  keybindingsWatchMode,
  parseKeybindings,
  readKeybindings,
  watchKeybindings,
  writeKeybindings,
} from "./keybindings.ts";
import { removeDirStrict } from "../git/test-repo.ts";

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gram-keybindings-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeDirStrict(dir);
});

describe("parseKeybindings", () => {
  it("keeps valid chords and null, and explains the rest", () => {
    const { bindings, problems } = parseKeybindings(
      JSON.stringify({
        bindings: {
          "sidebar.toggle": "Mod+Shift+B",
          "panel.toggle": null,
          "focus.toggle": 3,
          bad: "mod+",
        },
      }),
    );
    expect(bindings).toEqual({ "sidebar.toggle": "mod+shift+b", "panel.toggle": null });
    expect(problems).toHaveLength(2);
  });

  it("treats an empty or binding-less file as no overrides, and invalid JSON as a problem", () => {
    expect(parseKeybindings("")).toEqual({ bindings: {}, problems: [] });
    expect(parseKeybindings('{"$schema": "./x"}')).toEqual({ bindings: {}, problems: [] });
    expect(parseKeybindings("{ nope").problems[0]).toContain("isn't valid JSON");
    expect(parseKeybindings('{"bindings": []}').problems).toHaveLength(1);
  });
});

describe("keybindings file", () => {
  it("polls the file when its folder can't be watched, and says so", async () => {
    const dir = await tempDir();
    const failed = vi.fn();
    const stop = watchKeybindings(join(dir, "gone"), () => {}, {
      platform: "linux",
      pollMs: 10,
      onWatchFailed: failed,
    });
    expect(failed).toHaveBeenCalledOnce();
    stop();
    stop();
  });

  it("reads a missing file as empty, writes the schema beside it and round-trips", async () => {
    const dir = await tempDir();
    expect(await readKeybindings(dir)).toEqual({
      path: join(dir, KEYBINDINGS_FILE),
      bindings: {},
      problems: [],
    });
    expect(JSON.parse(await readFile(join(dir, KEYBINDINGS_SCHEMA_FILE), "utf8"))).toMatchObject({
      title: "Gram keybindings",
    });

    await writeKeybindings(dir, { "thread.new": "mod+shift+n" });
    const text = await readFile(join(dir, KEYBINDINGS_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({
      $schema: `./${KEYBINDINGS_SCHEMA_FILE}`,
      bindings: { "thread.new": "mod+shift+n" },
    });
    expect((await readKeybindings(dir)).bindings).toEqual({ "thread.new": "mod+shift+n" });
  });

  it("polls on macOS and Windows and watches the folder elsewhere", () => {
    expect(keybindingsWatchMode("win32")).toBe("poll");
    expect(keybindingsWatchMode("darwin")).toBe("poll");
    expect(keybindingsWatchMode("linux")).toBe("watch");
  });

  const modes = [
    ["this platform's mode", process.platform],
    ["stat polling, as on Windows", "win32"],
  ] as const;

  it.each(modes)(
    "notices when the file changes on disk with %s, then stops",
    async (_mode, platform) => {
      const dir = await tempDir();
      const noticed = Promise.withResolvers<void>();
      const onChange = vi.fn(() => noticed.resolve());
      const stop = watchKeybindings(dir, onChange, { debounceMs: 20, pollMs: 20, platform });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await writeFile(join(dir, "other.txt"), "x");
        await writeFile(join(dir, KEYBINDINGS_FILE), '{"bindings": {}}');
        await Promise.race([
          noticed.promise,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("no change to keybindings.json was noticed")),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        stop();
        stop();
      }
      const calls = onChange.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      await writeFile(join(dir, KEYBINDINGS_FILE), '{"bindings": {"thread.new": null}}');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onChange).toHaveBeenCalledTimes(calls);
    },
    20_000,
  );
});

describe("a broken keybindings.json", () => {
  it("leaves the last good version in use and says why in keybindings.json.error", async () => {
    const dir = await tempDir();
    const error = join(dir, KEYBINDINGS_ERROR_FILE);
    await writeKeybindings(dir, { "thread.new": "mod+shift+n" });

    // A half-finished edit: invalid JSON.
    await writeFile(join(dir, KEYBINDINGS_FILE), '{"bindings": {"thread.new": "mod+shift+m"');
    const broken = await readKeybindings(dir);
    expect(broken.bindings).toEqual({ "thread.new": "mod+shift+n" });
    expect(broken.problems[0]).toContain("isn't valid JSON");
    expect(broken.problems.at(-1)).toMatch(/keeps using the last good version, saved \d{4}-/);
    const reason = await readFile(error, "utf8");
    expect(reason).toContain(join(dir, KEYBINDINGS_FILE));
    expect(reason).toContain("isn't valid JSON");
    expect(reason).toContain("Gram keeps using the last good version");

    // One bad chord breaks the version as a whole: none of its changes apply.
    await writeFile(
      join(dir, KEYBINDINGS_FILE),
      JSON.stringify({ bindings: { "thread.new": "mod+shift+m", "panel.toggle": "mod+" } }),
    );
    expect((await readKeybindings(dir)).bindings).toEqual({ "thread.new": "mod+shift+n" });

    // Fixed: the new version applies, becomes the last good one, and the error file goes.
    await writeFile(
      join(dir, KEYBINDINGS_FILE),
      JSON.stringify({ bindings: { "thread.new": null } }),
    );
    expect(await readKeybindings(dir)).toMatchObject({
      bindings: { "thread.new": null },
      problems: [],
    });
    await expect(readFile(error, "utf8")).rejects.toThrow();
    await writeFile(join(dir, KEYBINDINGS_FILE), "{");
    expect((await readKeybindings(dir)).bindings).toEqual({ "thread.new": null });
  });

  it("keeps the last good version across a restart, since it is kept on disk", async () => {
    const dir = await tempDir();
    await writeKeybindings(dir, { "thread.new": "mod+shift+n" });
    expect(await readFile(join(dir, KEYBINDINGS_LAST_GOOD_FILE), "utf8")).toContain("mod+shift+n");
    await writeFile(join(dir, KEYBINDINGS_FILE), "nope");
    // A fresh read, as after a restart, finds the kept copy.
    expect((await readKeybindings(dir)).bindings).toEqual({ "thread.new": "mod+shift+n" });
  });

  it("applies what it can read when there is no good version to fall back on", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, KEYBINDINGS_FILE),
      JSON.stringify({ bindings: { "thread.new": "mod+shift+n", bad: "mod+" } }),
    );
    const read = await readKeybindings(dir);
    expect(read.bindings).toEqual({ "thread.new": "mod+shift+n" });
    expect(read.problems.at(-1)).toBe("There is no earlier good version to keep using.");
    expect(await readFile(join(dir, KEYBINDINGS_ERROR_FILE), "utf8")).toContain(
      "There is no earlier good version",
    );
  });

  it("treats a deleted file as no overrides, not as broken", async () => {
    const dir = await tempDir();
    await writeKeybindings(dir, { "thread.new": "mod+shift+n" });
    await rm(join(dir, KEYBINDINGS_FILE));
    expect(await readKeybindings(dir)).toMatchObject({ bindings: {}, problems: [] });
  });
});
