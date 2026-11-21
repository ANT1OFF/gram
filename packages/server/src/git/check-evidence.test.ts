import { VERIFY_EVIDENCE_ENV, VERIFY_EVIDENCE_MAX_BYTES } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import * as nodePath from "node:path";

import { evidenceDirOf, evidenceImage, freshEvidenceDir, listEvidence } from "./check-evidence.ts";
import { LOCAL_CHECK_ISOLATION, spawnCheck } from "./local-checks.ts";
import { removeDir, tempDir, write } from "./test-repo.ts";

/** A run's log in a fresh folder, with `files` in its evidence folder. */
const runWith = (files: Record<string, string>) => {
  const dir = tempDir();
  const log = nodePath.join(dir, "run.log");
  write(log, "");
  for (const [name, content] of Object.entries(files))
    write(nodePath.join(evidenceDirOf(log), name), content);
  return { dir, log };
};

describe("a verify run's evidence", () => {
  it("lists the manifest's items in its order, and only files directly in the folder", () => {
    const { dir, log } = runWith({
      "b.png": "b",
      "a.webm": "video",
      "notes.txt": "seen",
      "manifest.json": JSON.stringify({
        items: [
          { file: "b.png", caption: "  The end  ", kind: "screenshot" },
          { file: "notes.txt", kind: "log" },
          { file: "b.png", caption: "again" },
          { file: "../run.log" },
          { file: "missing.png" },
          { file: "manifest.json" },
          { file: "a.webm", kind: "invented" },
        ],
      }),
    });
    expect(listEvidence(log)).toEqual([
      { file: "b.png", kind: "screenshot", caption: "The end", size: 1 },
      { file: "notes.txt", kind: "log", size: 4 },
      { file: "a.webm", kind: "video", size: 5 },
    ]);
    removeDir(dir);
  });

  it("without a manifest lists pictures and videos by name, and never follows a link", () => {
    const { dir, log } = runWith({ "2.png": "x", "1.webm": "y", "out.txt": "z" });
    write(nodePath.join(dir, "secret.png"), "outside");
    symlinkSync(nodePath.join(dir, "secret.png"), nodePath.join(evidenceDirOf(log), "0.png"));
    expect(listEvidence(log).map((item) => [item.file, item.kind])).toEqual([
      ["1.webm", "video"],
      ["2.png", "screenshot"],
    ]);
    expect(evidenceImage(log, "0.png")).toBeUndefined();
    removeDir(dir);
  });

  it("serves a listed picture's bytes, and nothing it didn't list or that isn't a picture", () => {
    const { dir, log } = runWith({
      "shot.png": "png-bytes",
      "big.png": "x".repeat(VERIFY_EVIDENCE_MAX_BYTES + 1),
      "tour.webm": "video",
      "hidden.png": "not listed",
      "manifest.json": JSON.stringify({
        items: [{ file: "shot.png" }, { file: "big.png" }, { file: "tour.webm" }],
      }),
    });
    expect(evidenceImage(log, "shot.png")).toEqual({
      path: "shot.png",
      mediaType: "image/png",
      size: 9,
      tooLarge: false,
      base64: Buffer.from("png-bytes").toString("base64"),
    });
    expect(evidenceImage(log, "big.png")).toMatchObject({ tooLarge: true });
    expect(evidenceImage(log, "big.png")).not.toHaveProperty("base64");
    expect(evidenceImage(log, "tour.webm")).toBeUndefined();
    expect(evidenceImage(log, "hidden.png")).toBeUndefined();
    expect(evidenceImage(log, "../run.log")).toBeUndefined();
    removeDir(dir);
  });

  it("starts each run with an empty folder", () => {
    const { dir, log } = runWith({ "old.png": "from the last run" });
    const fresh = freshEvidenceDir(log)!;
    expect(fresh).toBe(evidenceDirOf(log));
    expect(readdirSync(fresh)).toEqual([]);
    expect(listEvidence(log)).toEqual([]);
    removeDir(dir);
  });
});

describe.skipIf(process.platform === "win32")("a check's evidence folder", () => {
  it.live("is given to a verify driver's run only, never inherited from the server", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const log = nodePath.join(dir, "check.log");
      const environment = {
        base: { PATH: "/usr/bin:/bin", [VERIFY_EVIDENCE_ENV]: "/invented" },
        pathValue: "/usr/bin:/bin",
      };
      const command = `echo "evidence=\${${VERIFY_EVIDENCE_ENV}-unset}"`;
      const base = { isolation: LOCAL_CHECK_ISOLATION, command, timeoutMs: 5_000 };
      expect(yield* spawnCheck(dir, log, environment, base)).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toContain("evidence=unset");
      expect(existsSync(evidenceDirOf(log))).toBe(false);

      write(nodePath.join(evidenceDirOf(log), "stale.png"), "from before");
      const driver = {
        ...base,
        command: `${command} && echo shot > "$${VERIFY_EVIDENCE_ENV}/shot.png"`,
        profile: "verify/flow/v1",
      };
      expect(yield* spawnCheck(dir, log, environment, driver)).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toContain(`evidence=${evidenceDirOf(log)}`);
      expect(listEvidence(log).map((item) => item.file)).toEqual(["shot.png"]);
      removeDir(dir);
    }),
  );
});
