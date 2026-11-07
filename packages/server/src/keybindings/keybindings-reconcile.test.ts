import type * as NativeFs from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS_FILE, watchKeybindings } from "./keybindings.ts";

const native = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof NativeFs>()),
  watch: native.watch,
}));

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  native.watch.mockReset();
});

const tick = () => vi.advanceTimersByTime(1150);

const setup = (platform: NodeJS.Platform = "darwin") => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "gram-keybindings-reconcile-"));
  dirs.push(dir);
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  native.watch.mockReturnValue(watcher);
  const changed = vi.fn();
  const failed = vi.fn();
  const stop = watchKeybindings(dir, changed, { platform, onWatchFailed: failed });
  stops.push(stop);
  const write = (text: string) => writeFileSync(join(dir, KEYBINDINGS_FILE), text);
  return { dir, watcher, changed, failed, stop, write };
};

describe("keybindings reconciliation", () => {
  it("notices a single immediate write without native watching, deduplicates and stops", () => {
    const { dir, watcher, changed, stop, write } = setup();
    write("first");
    tick();
    expect(changed).toHaveBeenCalledTimes(1);
    tick();
    expect(changed).toHaveBeenCalledTimes(1);

    // Editor atomic replacement, even with the same contents, is a new file.
    const replacement = join(dir, "replacement");
    writeFileSync(replacement, "first");
    renameSync(replacement, join(dir, KEYBINDINGS_FILE));
    tick();
    expect(changed).toHaveBeenCalledTimes(2);
    rmSync(join(dir, KEYBINDINGS_FILE));
    tick();
    expect(changed).toHaveBeenCalledTimes(3);

    write("last");
    vi.advanceTimersToNextTimer(); // stop with a debounce still pending
    stop();
    stop();
    tick();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(native.watch).not.toHaveBeenCalled();
    expect(watcher.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes Linux native events immediately and deduplicates repeated notifications", () => {
    const { changed, write } = setup("linux");
    write("first");
    const notify = native.watch.mock.calls[0]![1];
    notify("change", KEYBINDINGS_FILE);
    vi.advanceTimersByTime(150);
    expect(changed).toHaveBeenCalledTimes(1);
    tick();
    notify("change", KEYBINDINGS_FILE);
    tick();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps Linux driven by native events, with polling if its watch fails later", () => {
    const { watcher, changed, failed, write } = setup("linux");
    write("first");
    tick();
    expect(changed).not.toHaveBeenCalled();
    const error = new Error("synthetic watch failure");
    watcher.emit("error", error);
    expect(failed).toHaveBeenCalledWith(error);
    tick();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
