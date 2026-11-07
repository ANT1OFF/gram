import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KEYBINDINGS_FILE,
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
