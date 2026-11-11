import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const sources = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe("the decision windows", () => {
  it("are left out of every loop over the app's windows", () => {
    // Every window list goes through `appWindows` (or `focusedAppWindow`), so nothing the app does
    // to its windows reloads, hides, themes or messages the ask or the lending sheet.
    const found = [
      ...sources(join(root, "packages", "shell", "src")),
      ...sources(join(root, "apps", "desktop", "src")),
    ]
      .filter((file) => !file.endsWith(join("electron", "decision-windows.ts")))
      .filter((file) =>
        /BrowserWindow\.(getAllWindows|getFocusedWindow)\(/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(root, file));
    expect(found).toEqual([]);
  });
});
