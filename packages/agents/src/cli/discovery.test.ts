import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  BinaryNotFound,
  parseProbeOutput,
  pathCandidates,
  resolveBinary,
  type BinaryFs,
} from "./discovery.ts";

describe("CLI discovery", () => {
  it("keeps the probed path independent of the selected adapter", () => {
    for (const name of ["claude", "codex"]) {
      expect(
        parseProbeOutput(
          `banner\n\0__SB_PROBE__\0/installed/${name}\n\0__SB_ENV__\0PATH=/installed\0`,
        ),
      ).toEqual({
        commandPath: `/installed/${name}`,
        env: { PATH: "/installed" },
      });
      expect(pathCandidates({ PATH: "/installed" }, "linux", name)).toEqual([`/installed/${name}`]);
    }
  });

  it("skips unreadable and duplicate realpaths without a Claude-specific failure", async () => {
    const reads: Array<string> = [];
    const fs: BinaryFs = {
      realpath: (path) => Effect.succeed(path === "/alias" ? "/unreadable" : path),
      readHead: (path) =>
        Effect.suspend(() => {
          reads.push(path);
          return path === "/unreadable"
            ? Effect.fail("EACCES")
            : Effect.succeed(new TextEncoder().encode("#!/bin/sh\n"));
        }),
    };
    const error = await Effect.runPromise(
      Effect.flip(resolveBinary(["/unreadable", "/alias", "/wrapper"], fs)),
    );
    expect(reads).toEqual(["/unreadable", "/wrapper"]);
    expect(error).toBeInstanceOf(BinaryNotFound);
    expect(error.skipped).toEqual([
      { path: "/unreadable", reason: "unreadable" },
      { path: "/wrapper", reason: "shell wrapper" },
    ]);
    expect(error.message).toBe(
      "No executable on the login-shell PATH (skipped: /unreadable, /wrapper)",
    );
  });
});
