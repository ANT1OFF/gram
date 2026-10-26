import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractMacArchive,
  verifyBundleIdentity,
  verifyMacCodeSignature,
  type MacCodeSignature,
} from "@gram/shell/modules/update";
import { describe, expect, it } from "vitest";

import { offerable, verifyNativeCandidate, type CandidateChecks } from "./native-candidate.ts";
import { snapshotCandidate } from "./native-snapshot.ts";

const TEAM = "ANVR857GFZ";

/** A stored (uncompressed) ZIP, as Gram's bounded reader takes them. */
function zip(entries: { name: string; data: Buffer; mode: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const head = Buffer.alloc(30);
    const dir = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt32LE(entry.data.length, 18);
    head.writeUInt32LE(entry.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    local.push(head, name, entry.data);
    central.push(dir, name);
    offset += head.length + name.length + entry.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** An app.asar holding only `package.json`, in Electron's pickle layout. */
function asar(pkg: object): Buffer {
  const data = Buffer.from(JSON.stringify(pkg));
  const json = Buffer.from(
    JSON.stringify({ files: { "package.json": { size: data.length, offset: "0" } } }),
  );
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(json.length, 4);
  padded.copy(header, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(header.length, 4);
  return Buffer.concat([prefix, header, data]);
}

/**
 * A ZIP of a Gram.app whose Info.plist says `plistVersion` and whose app.asar says `asarVersion`:
 * enough for the real identity check, not a runnable app.
 */
function gramZip(plistVersion: string, asarVersion = plistVersion): string {
  const plist = Buffer.from(
    `<plist><dict><key>CFBundleIdentifier</key><string>io.github.ant1off.gram</string>` +
      `<key>CFBundleExecutable</key><string>Gram</string>` +
      `<key>CFBundleShortVersionString</key><string>${plistVersion}</string>` +
      `<key>CFBundleVersion</key><string>${plistVersion}</string></dict></plist>`,
  );
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(0x0100000c, 4);
  const dir = 0o040755;
  const file = 0o100644;
  const archive = zip([
    { name: "Gram.app/", data: Buffer.alloc(0), mode: dir },
    { name: "Gram.app/Contents/", data: Buffer.alloc(0), mode: dir },
    { name: "Gram.app/Contents/Info.plist", data: plist, mode: file },
    { name: "Gram.app/Contents/MacOS/", data: Buffer.alloc(0), mode: dir },
    { name: "Gram.app/Contents/MacOS/Gram", data: macho, mode: 0o100755 },
    { name: "Gram.app/Contents/Resources/", data: Buffer.alloc(0), mode: dir },
    {
      name: "Gram.app/Contents/Resources/app.asar",
      data: asar({ name: "@gram/desktop", productName: "Gram", version: asarVersion }),
      mode: file,
    },
  ]);
  const path = join(mkdtempSync(join(tmpdir(), "gram-candidate-zip-")), "update.zip");
  writeFileSync(path, archive);
  return path;
}

/** macOS's verdict on a synthetic bundle, as `requireMacCodeSignature` reads it. */
const accepted: MacCodeSignature = {
  requirement: "satisfied",
  identifier: "io.github.ant1off.gram",
  teamId: TEAM,
  hardenedRuntime: true,
  gatekeeper: "Notarized Developer ID",
  staple: "valid",
};

function checks(signature: MacCodeSignature = accepted): CandidateChecks & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    extract: extractMacArchive,
    identity: verifyBundleIdentity,
    // The real policy, with macOS's answers supplied: the synthetic bundle can't be signed.
    signature: async (bundle, teamId) => {
      seen.push(bundle);
      await verifyMacCodeSignature(bundle, teamId, { notarization: true }, async () => signature);
    },
  };
}

const run = async (zipPath: string, version: string, check = checks(), tempDir = tmpdir()) => {
  const snapshot = await snapshotCandidate(zipPath, tmpdir());
  try {
    await verifyNativeCandidate(
      {
        snapshot,
        version,
        currentVersion: "0.1.0-rc.17",
        channel: "prerelease",
        teamId: TEAM,
        tempDir,
      },
      check,
    );
    return snapshot.sha256;
  } finally {
    await snapshot.close();
  }
};

describe("verifyNativeCandidate", () => {
  it("accepts a notarized Gram whose bundle and app.asar both say the offered version", async () => {
    const path = gramZip("0.1.0-rc.18");
    const temp = mkdtempSync(join(tmpdir(), "gram-candidate-tmp-"));
    const check = checks();
    const digest = await run(path, "0.1.0-rc.18", check, temp);
    expect(digest).toBe(
      createHash("sha256")
        .update(await import("node:fs").then((fs) => fs.readFileSync(path)))
        .digest("hex"),
    );
    expect(check.seen[0]).toMatch(/gram-native-verify-.*\/Gram\.app$/);
    // The unpacked copy is gone again.
    expect(readdirSync(temp)).toEqual([]);
  });

  it("refuses an older signed ZIP replayed under a newer version", async () => {
    await expect(run(gramZip("0.1.0-rc.16"), "0.1.0-rc.18")).rejects.toThrow(
      "Unexpected Gram bundle identity/version",
    );
    await expect(run(gramZip("0.1.0-rc.18", "0.1.0-rc.16"), "0.1.0-rc.18")).rejects.toThrow(
      "Unexpected packaged Gram product/version",
    );
  });

  it("refuses a same-team build that isn't notarized, stapled or hardened", async () => {
    for (const [signature, message] of [
      [{ ...accepted, gatekeeper: null }, /notarized/],
      [{ ...accepted, staple: "missing" }, /no notarization ticket/],
      [{ ...accepted, hardenedRuntime: false }, /hardened runtime/],
      [{ ...accepted, teamId: "OTHERTEAM1" }, /Team ID/],
      [{ ...accepted, requirement: "unsatisfied" }, /not Gram signed/],
    ] as const) {
      await expect(run(gramZip("0.1.0-rc.18"), "0.1.0-rc.18", checks(signature))).rejects.toThrow(
        message,
      );
    }
  });

  it("refuses a version that isn't strictly newer or isn't on the channel, before unpacking", async () => {
    const check = checks();
    for (const version of ["0.1.0-rc.17", "0.1.0-rc.16"])
      await expect(run(gramZip(version), version, check)).rejects.toThrow(/isn't an update/);
    await expect(
      verifyNativeCandidate(
        {
          snapshot: { path: gramZip("0.2.0-rc.1"), intact: async () => true },
          version: "0.2.0-rc.1",
          currentVersion: "0.1.0",
          channel: "stable",
          teamId: TEAM,
          tempDir: tmpdir(),
        },
        check,
      ),
    ).rejects.toThrow(/isn't an update/);
    expect(check.seen).toEqual([]);
  });

  it("refuses a snapshot whose private copy was replaced while it was verified", async () => {
    await expect(
      verifyNativeCandidate(
        {
          snapshot: { path: gramZip("0.1.0-rc.18"), intact: async () => false },
          version: "0.1.0-rc.18",
          currentVersion: "0.1.0-rc.17",
          channel: "prerelease",
          teamId: TEAM,
          tempDir: tmpdir(),
        },
        checks(),
      ),
    ).rejects.toThrow(/changed while it was being verified/);
  });
});

describe("offerable", () => {
  it("is strictly newer, with RCs on Pre-release only", () => {
    expect(offerable("0.1.0-rc.18", "0.1.0-rc.17", "prerelease")).toBe(true);
    expect(offerable("0.1.0", "0.1.0-rc.17", "stable")).toBe(true);
    expect(offerable("0.1.0-rc.18", "0.1.0-rc.17", "stable")).toBe(false);
    expect(offerable("0.1.0-rc.17", "0.1.0-rc.17", "prerelease")).toBe(false);
    expect(offerable("next", "0.1.0-rc.17", "prerelease")).toBe(false);
  });
});
