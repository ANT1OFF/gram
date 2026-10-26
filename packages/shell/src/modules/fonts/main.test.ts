import { describe, expect, it, vi } from "vitest";

import { listInstalledFonts, parseLineFonts, parseMacFonts } from "./main.ts";

describe("installed fonts", () => {
  it("reads families from system_profiler, sorted, deduplicated, without private ones", () => {
    const json = JSON.stringify({
      SPFontsDataType: [
        { typefaces: [{ family: "Menlo" }, { family: "Menlo" }] },
        { typefaces: [{ family: ".SF NS" }, { family: "Avenir Next" }] },
        { name: "broken.ttf" },
      ],
    });
    expect(parseMacFonts(json)).toEqual(["Avenir Next", "Menlo"]);
  });

  it("reads one family per line, taking fc-list's first localized name", () => {
    expect(parseLineFonts("Consolas\r\nArial\r\n\r\nArial\r\n")).toEqual(["Arial", "Consolas"]);
    expect(
      parseLineFonts("DejaVu Sans,DejaVu Sans Condensed\nNoto Sans CJK JP,Noto Sans CJK\n"),
    ).toEqual(["DejaVu Sans", "Noto Sans CJK JP"]);
  });

  it("runs each platform's lister and degrades to nothing when it fails", async () => {
    const run = vi.fn(
      async (_file: string, _args: readonly string[]) => "Consolas\r\nSegoe UI\r\n",
    );
    expect(await listInstalledFonts("win32", run, { SystemRoot: "D:\\Windows" })).toEqual([
      "Consolas",
      "Segoe UI",
    ]);
    const [file, args] = run.mock.calls[0]!;
    expect(file).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(expect.arrayContaining(["-NoProfile"]));
    expect(args.at(-1)).toMatch(/^\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8;/);

    const linux = vi.fn(async () => "DejaVu Sans Mono\n");
    expect(await listInstalledFonts("linux", linux)).toEqual(["DejaVu Sans Mono"]);
    expect(linux).toHaveBeenCalledWith("fc-list", [":", "family"]);

    const failing = vi.fn(async () => {
      throw new Error("system_profiler timed out");
    });
    expect(await listInstalledFonts("darwin", failing)).toEqual([]);
  });
});
