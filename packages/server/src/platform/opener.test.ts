import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { removeDir } from "../git/test-repo.ts";
import { makeNodeOpener, Opener, spawnInvocation, spawnOptions } from "./opener.ts";

const nodeOpener = makeNodeOpener();

describe("Opener", () => {
  it.effect("fails by default, so nothing launches unless main provides the live opener", () =>
    Effect.gen(function* () {
      const opener = yield* Opener;
      const error = yield* opener.launch({ file: "open", args: ["/tmp"] }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
    }),
  );

  it.effect("starts a program detached, tells its pid, and reports one that can't start", () =>
    Effect.gen(function* () {
      const launched: number[] = [];
      yield* makeNodeOpener((pid) => launched.push(pid)).launch({
        file: process.execPath,
        args: ["-e", ""],
      });
      expect(launched).toHaveLength(1);
      const error = yield* nodeOpener
        .launch({ file: "/nonexistent/gram-opener-test", args: [] })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/^Couldn't start \/nonexistent\/gram-opener-test:/);
    }),
  );
});

describe("spawnInvocation", () => {
  it("escapes a .cmd editor launch for cmd.exe, so nothing in the path expands or splits", () => {
    expect(
      spawnInvocation({
        file: "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
        args: ["--goto", "C:\\my repo\\%USERPROFILE%\\a^b & (1).ts:3"],
        shell: true,
      }),
    ).toEqual({
      file: "C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.cmd",
      args: ['^"--goto^"', '^"C:\\my^ repo\\^%USERPROFILE^%\\a^^b^ ^&^ ^(1^).ts:3^"'],
    });
  });

  it("passes a native program's arguments through untouched", () => {
    expect(spawnInvocation({ file: "explorer.exe", args: ['/select,"C:\\a %b%\\c.ts"'] })).toEqual({
      file: "explorer.exe",
      args: ['/select,"C:\\a %b%\\c.ts"'],
    });
  });
});

describe("spawnOptions", () => {
  it("starts hidden and detached unless the program asks for its window", () => {
    expect(spawnOptions({})).toEqual({
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
    // Explorer honours the hidden flag: the folder opens, in a window nobody sees.
    expect(spawnOptions({ window: true, verbatim: true })).toMatchObject({
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
  });
});

describe.skipIf(process.platform !== "win32")("Opener on Windows", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("launches a .cmd editor with a path full of cmd metacharacters, literally", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-opener-"));
      dirs.push(dir);
      // A stand-in editor, never a real one: it writes its first argument (quotes kept) to a file.
      const editor = join(dir, "fake editor.cmd");
      const out = join(dir, "out.txt");
      writeFileSync(editor, `@echo off\r\n>"${out}" echo [%1]\r\n`);
      const target = "C:\\projects\\%USERPROFILE%\\a^b & (c).ts:3";

      yield* nodeOpener.launch({ file: editor, args: [target], shell: true });

      let written = "";
      for (let attempt = 0; attempt < 200 && written === ""; attempt++) {
        yield* Effect.sleep("50 millis");
        try {
          written = readFileSync(out, "utf8").trim();
        } catch {
          written = "";
        }
      }
      expect(written).toBe(`["${target}"]`);
    }),
  );
});
