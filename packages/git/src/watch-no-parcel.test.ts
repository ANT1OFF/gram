import * as nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeDir, tempDir, write } from "./test-utils.ts";
import { subscribeRoot, type RootIgnore } from "./watch.ts";

// The packaged macOS and Windows apps ship without @parcel/watcher, so loading it there would throw.
const loads = vi.hoisted(() => ({ parcel: 0 }));
vi.mock("@parcel/watcher", () => {
  loads.parcel++;
  return { default: {} };
});

const noIgnore: RootIgnore = { topLevel: [], anyDepth: [] };

const dropEvents = () => undefined;

describe("node watch backend without @parcel/watcher", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it("imports the watch module and runs a node watch without loading @parcel/watcher", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const release = await subscribeRoot("node", dir, noIgnore, dropEvents);
    write(nodePath.join(dir, "edit.txt"), "x");
    await release();
    expect(loads.parcel).toBe(0);
  });

  it("loads @parcel/watcher once the parcel backend is asked for", async () => {
    const dir = tempDir();
    dirs.push(dir);
    await expect(subscribeRoot("parcel", dir, noIgnore, dropEvents)).rejects.toThrow();
    expect(loads.parcel).toBe(1);
  });
});
