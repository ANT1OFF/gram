import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  developerIdTeam,
  GRAM_MAC_TEAM_ID,
  macBundleTeam,
  macDesignatedRequirement,
  macRequirementSha256,
  parseCodesignDisplay,
  parseGatekeeper,
  parseStaple,
  probeMacCodeSignature,
  requireMacCodeSignature,
  verifyMacCodeSignature,
  type MacCodeSignature,
} from "./mac-signature.ts";

const TEAM = "FAKETEAM01";
const good: MacCodeSignature = {
  requirement: "satisfied",
  identifier: "io.github.ant1off.gram",
  teamId: TEAM,
  hardenedRuntime: true,
  gatekeeper: "Notarized Developer ID",
  staple: "valid",
};

describe("Developer ID publisher policy", () => {
  it("pins Gram's identifier, Apple's Developer ID chain and the team", () => {
    expect(macDesignatedRequirement(TEAM)).toBe(
      'anchor apple generic and identifier "io.github.ant1off.gram" and certificate ' +
        "1[field.1.2.840.113635.100.6.2.6] exists and certificate " +
        'leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "FAKETEAM01"',
    );
    expect(macRequirementSha256(TEAM)).toMatch(/^[a-f0-9]{64}$/);
    expect(macRequirementSha256(TEAM)).not.toBe(macRequirementSha256("OTHERTEAM1"));
    for (const bad of ["", "faketeam01", "SHORT", 'FAKETEAM0" or "1', "FAKETEAM012"])
      expect(() => macDesignatedRequirement(bad)).toThrow("Team ID");
  });

  it("reads the team only from a Developer ID Application identity name", () => {
    expect(developerIdTeam("Developer ID Application: Example Person (FAKETEAM01)")).toBe(TEAM);
    expect(developerIdTeam("Apple Development: Example Person (FAKETEAM01)")).toBeUndefined();
    expect(developerIdTeam("Developer ID Installer: Example Person (FAKETEAM01)")).toBeUndefined();
    expect(developerIdTeam("Developer ID Application: Example Person")).toBeUndefined();
  });

  it("ships with no publisher until the owner sets the real Team ID", () => {
    // Changing this is the deliberate activation step in docs/UPDATES.md.
    expect(GRAM_MAC_TEAM_ID === null || /^[A-Z0-9]{10}$/.test(GRAM_MAC_TEAM_ID)).toBe(true);
  });

  it("parses codesign and spctl output", () => {
    expect(
      parseCodesignDisplay(
        "Executable=/x/Gram.app/Contents/MacOS/Gram\nIdentifier=io.github.ant1off.gram\n" +
          "CodeDirectory v=20500 size=439 flags=0x10000(runtime) hashes=3+7 location=embedded\n" +
          "Authority=Developer ID Application: Example Person (FAKETEAM01)\nTeamIdentifier=FAKETEAM01\n",
      ),
    ).toEqual({
      identifier: "io.github.ant1off.gram",
      teamId: TEAM,
      hardenedRuntime: true,
      adhoc: false,
    });
    expect(
      parseCodesignDisplay(
        "Identifier=io.github.ant1off.gram\nCodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0\nSignature=adhoc\nTeamIdentifier=not set\n",
      ),
    ).toEqual({
      identifier: "io.github.ant1off.gram",
      teamId: null,
      hardenedRuntime: false,
      adhoc: true,
    });
    expect(parseGatekeeper(0, "/x/Gram.app: accepted\nsource=Notarized Developer ID\n")).toBe(
      "Notarized Developer ID",
    );
    expect(
      parseGatekeeper(3, "/x/Gram.app: rejected\nsource=Unnotarized Developer ID\n"),
    ).toBeNull();
    expect(parseGatekeeper(0, "/x/Gram.app: rejected\n")).toBeNull();
  });

  it.each<[Partial<MacCodeSignature>, string]>([
    [{ requirement: "unsatisfied" }, "not Gram signed by its Developer ID team"],
    [{ requirement: "invalid" }, "invalid or incomplete"],
    [{ identifier: "com.example.other" }, "bundle identifier or Team ID"],
    [{ teamId: "OTHERTEAM1" }, "bundle identifier or Team ID"],
    [{ teamId: null }, "bundle identifier or Team ID"],
    [{ hardenedRuntime: false }, "hardened runtime"],
    [{ gatekeeper: null }, "notarized"],
    [{ gatekeeper: "Developer ID" }, "notarized"],
    [{ staple: "missing" }, "no notarization ticket is stapled"],
    [{ staple: "invalid" }, "stapled notarization ticket is invalid"],
    [{ staple: "unavailable" }, "could not be checked"],
    [{ staple: null }, "could not be checked"],
  ])("refuses %j", (patch, message) => {
    expect(() => requireMacCodeSignature({ ...good, ...patch }, TEAM)).toThrow(message);
  });

  it("accepts a notarized, stapled build, and skips only Gatekeeper and the staple when told", () => {
    expect(() => requireMacCodeSignature(good, TEAM)).not.toThrow();
    expect(() =>
      requireMacCodeSignature({ ...good, gatekeeper: null, staple: null }, TEAM, {
        notarization: false,
      }),
    ).not.toThrow();
    expect(() =>
      requireMacCodeSignature({ ...good, requirement: "unsatisfied" }, TEAM, {
        notarization: false,
      }),
    ).toThrow("Developer ID team");
    expect(() => requireMacCodeSignature(good, "nope")).toThrow("no publisher Team ID");
  });

  it("maps codesign's exit status: 0 satisfied, 3 unsatisfied, anything else invalid", async () => {
    for (const [status, expected] of [
      [0, "satisfied"],
      [3, "unsatisfied"],
      [1, "invalid"],
      [null, "invalid"],
    ] as const) {
      const seen: string[][] = [];
      const signature = await probeMacCodeSignature(
        "/x/Gram.app",
        TEAM,
        { notarization: true },
        async (file, args) => {
          seen.push([file, ...args]);
          if (args[0] === "--verify") return { status, out: "" };
          if (args[0] === "--display")
            return {
              status: 0,
              out: "Identifier=io.github.ant1off.gram\nTeamIdentifier=FAKETEAM01\n",
            };
          return { status: 0, out: "/x/Gram.app: accepted\nsource=Notarized Developer ID\n" };
        },
      );
      expect(signature.requirement).toBe(expected);
      expect(seen[0]).toEqual([
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        "-R",
        `=${macDesignatedRequirement(TEAM)}`,
        "/x/Gram.app",
      ]);
      expect(seen[2]?.[0]).toBe("/usr/sbin/spctl");
      expect(seen[3]).toEqual(["/usr/bin/xcrun", "stapler", "validate", "/x/Gram.app"]);
    }
  });

  it.each([
    [0, "Processing: /x/Gram.app\nThe validate action worked!\n", "valid"],
    [65, "Processing: /x/Gram.app\nGram.app does not have a ticket stapled to it.\n", "missing"],
    [
      65,
      'Processing: /x/Gram.app\nCloudKit query for Gram.app failed due to "Record not found".\n',
      "invalid",
    ],
    [66, "Processing: /x/Gram.app\n", "invalid"],
    [null, "spawn /usr/bin/xcrun ENOENT", "unavailable"],
  ] as const)("reads stapler validate's exit %s as %s's ticket", (status, out, staple) => {
    expect(parseStaple(status, out)).toBe(staple);
  });

  it.each([
    [65, "Gram.app does not have a ticket stapled to it.", "no notarization ticket is stapled"],
    [68, "The staple and validate action failed! Error 68.", "ticket is invalid"],
    [null, "timed out", "could not be checked"],
  ] as const)(
    "refuses before staging when stapler validate exits %s, even with Gatekeeper accepting",
    async (status, out, message) => {
      const run = async (_file: string, args: readonly string[]) =>
        args[0] === "--verify"
          ? { status: 0, out: "" }
          : args[0] === "--display"
            ? {
                status: 0,
                out:
                  "Identifier=io.github.ant1off.gram\nTeamIdentifier=FAKETEAM01\n" +
                  "CodeDirectory v=20500 size=439 flags=0x10000(runtime) hashes=3+7\n",
              }
            : args[0] === "--assess"
              ? { status: 0, out: "/x/Gram.app: accepted\nsource=Notarized Developer ID\n" }
              : { status, out };
      await expect(
        verifyMacCodeSignature(
          "/x/Gram.app",
          TEAM,
          { notarization: true },
          (bundle, team, options) => probeMacCodeSignature(bundle, team, options, run),
        ),
      ).rejects.toThrow(message);
      // The same verdicts with a valid ticket pass: only the staple refused.
      await expect(
        verifyMacCodeSignature(
          "/x/Gram.app",
          TEAM,
          { notarization: true },
          (bundle, team, options) =>
            probeMacCodeSignature(bundle, team, options, async (file, args) =>
              file === "/usr/bin/xcrun"
                ? { status: 0, out: "The validate action worked!" }
                : run(file, args),
            ),
        ),
      ).resolves.toBeUndefined();
    },
  );
});

const shown = (status: number | null, out: string) => async () => ({ status, out });

describe("which team signed an installation", () => {
  it.each([
    [0, "Identifier=io.github.ant1off.gram\nTeamIdentifier=FAKETEAM01\n", TEAM],
    [0, "Identifier=io.github.ant1off.gram\nSignature=adhoc\nTeamIdentifier=not set\n", null],
    [1, "/Applications/Gram.app: code object is not signed at all", null],
    [1, "/Applications/Gram.app: bundle format unrecognized, invalid, or unsuitable", undefined],
    [null, "spawn /usr/bin/codesign ENOENT", undefined],
  ] as const)("reads codesign --display exit %s as team %s", async (status, out, team) => {
    expect(await macBundleTeam("/Applications/Gram.app", shown(status, out))).toBe(team);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function adhocGram() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gram-codesign-test-")));
  dirs.push(root);
  const app = join(root, "Gram.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
      "<key>CFBundleIdentifier</key><string>io.github.ant1off.gram</string>" +
      "<key>CFBundleExecutable</key><string>Gram</string></dict></plist>",
  );
  await writeFile(join(app, "Contents/Resources/resource.txt"), "sealed");
  await copyFile("/usr/bin/true", join(app, "Contents/MacOS/Gram"));
  const sign = spawnSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--identifier",
      "io.github.ant1off.gram",
      app,
    ],
    { encoding: "utf8" },
  );
  expect(sign.status, sign.stderr).toBe(0);
  return app;
}

// macOS's own tools on a throwaway bundle: a copy of /usr/bin/true, ad-hoc signed as Gram with the
// hardened runtime. Nothing is launched; an ad-hoc signature is exactly what must not pass.
describe.skipIf(process.platform !== "darwin")("macOS verdict on a real ad-hoc bundle", () => {
  it("reports an ad-hoc Gram as unsatisfied, without a team, and refuses it", async () => {
    const app = await adhocGram();
    const signature = await probeMacCodeSignature(app, TEAM);
    expect(signature).toEqual({
      requirement: "unsatisfied",
      identifier: "io.github.ant1off.gram",
      teamId: null,
      hardenedRuntime: true,
      gatekeeper: null,
      staple: "missing",
    });
    await expect(verifyMacCodeSignature(app, TEAM)).rejects.toThrow("Developer ID team");
    // An ad-hoc installation names no team, so it isn't the publisher's.
    expect(await macBundleTeam(app)).toBeNull();
  });

  it("reports a bundle changed after signing as invalid", async () => {
    const app = await adhocGram();
    await writeFile(join(app, "Contents/Resources/resource.txt"), "changed");
    expect((await probeMacCodeSignature(app, TEAM, { notarization: false })).requirement).toBe(
      "invalid",
    );
    await expect(verifyMacCodeSignature(app, TEAM, { notarization: false })).rejects.toThrow(
      "invalid or incomplete",
    );
  });
});
