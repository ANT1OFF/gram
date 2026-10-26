import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateChannel, UpdateProgress } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { UPDATE_DIR_PREFIX } from "./config.ts";
const TEST_SIGNER = "A1".repeat(32);
import {
  createUpdater,
  statfsFreeBytes,
  unavailableUpdater,
  type ProcessResult,
  type UpdaterOptions,
} from "./updater.ts";

const ok = (stdout = ""): ProcessResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): ProcessResult => ({ status: 1, stdout: "", stderr });
const releases = JSON.stringify([
  { tagName: "v1.5.0-rc.1", isDraft: false },
  { tagName: "v1.4.0", isDraft: false },
  { tagName: "v1.3.0", isDraft: false },
]);
const assets = (...names: string[]) => JSON.stringify({ assets: names.map((name) => ({ name })) });
const probeOf = (version: string, product = "Gram") =>
  ok(
    `STATUS=Valid\nSUBJECT=CN=Synthetic Test Signer\nSHA256=${TEST_SIGNER}\n` +
      `PRODUCT=${product}\nVERSION=${version}\n`,
  );
/** The probe of a genuine installer, whose version resource is the one its name says. */
const validProbe = async (installer: string) =>
  probeOf(/gram_(.+)_x64-setup\.exe$/.exec(installer)?.[1] ?? "");

/** A fake `gh` keyed on the subcommand; records every call. */
function fakeGh(responses: Record<string, (args: readonly string[]) => ProcessResult>) {
  const calls: string[][] = [];
  const gh: UpdaterOptions["gh"] = async (args) => {
    calls.push([...args]);
    const respond = responses[args.slice(0, 2).join(" ")];
    return respond ? respond(args) : failed(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

let tempDir: string;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function updater(overrides: Partial<UpdaterOptions> & Pick<UpdaterOptions, "gh">) {
  tempDir = mkdtempSync(join(tmpdir(), "gram-updater-"));
  const warnings: string[] = [];
  const instance = createUpdater({
    repo: "ANT1OFF/gram",
    expectedSignerSha256: TEST_SIGNER,
    currentVersion: "1.4.0",
    platform: "win32",
    tempDir,
    probeSignature: validProbe,
    readPrefs: async () => ({ channel: "stable" }),
    warn: (m) => warnings.push(m),
    // The test machine's own disk isn't the subject; the free-space case passes its own.
    freeBytes: async () => undefined,
    ...overrides,
  });
  return { instance, warnings };
}

describe("check", () => {
  it("reports no update channel without a releases repo, and never runs gh", async () => {
    const { gh, calls } = fakeGh({ "auth status": () => ok(), "release list": () => ok(releases) });
    const { instance } = updater({ gh, repo: null, platform: "darwin" });
    expect(await instance.check("stable")).toEqual({
      available: false,
      unavailable: true,
      noReleaseChannel: true,
      currentVersion: "1.4.0",
      canSelfInstall: false,
    });
    expect(calls).toEqual([]);

    const windows = updater({ gh, repo: null }).instance;
    await expect(windows.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(
      "doesn't publish releases",
    );
    expect(calls).toEqual([]);
  });

  it("is unavailable when gh isn't authenticated, and caches that briefly", async () => {
    let clock = 0;
    const { gh, calls } = fakeGh({ "auth status": () => failed("not logged in") });
    const { instance } = updater({ gh, now: () => clock });
    expect(await instance.check("stable")).toEqual({
      available: false,
      unavailable: true,
      currentVersion: "1.4.0",
      canSelfInstall: true,
    });
    await instance.check("stable");
    expect(calls).toHaveLength(1);
    clock = 15_001;
    await instance.check("stable");
    expect(calls).toHaveLength(2);
  });

  it("is unavailable on an unparseable version, a failed list or bad output", async () => {
    const auth = { "auth status": () => ok() };
    for (const [options, list] of [
      [{ currentVersion: "dev" }, () => ok(releases)],
      [{}, () => failed("HTTP 502")],
      [{}, () => ok("<html>")],
      [{}, () => ok("{}")],
    ] as const) {
      const { gh } = fakeGh({ ...auth, "release list": list });
      const { instance, warnings } = updater({ gh, ...options });
      expect(await instance.check("stable")).toMatchObject({ available: false, unavailable: true });
      expect(warnings).toHaveLength(1);
    }
  });

  it("offers the newest release on the channel with the picker list", async () => {
    const { gh, calls } = fakeGh({
      "auth status": () => ok(),
      "release list": () => ok(releases),
      "release view": () =>
        ok(assets("gram_1.5.0-rc.1_arm64.pkg", "gram_1.5.0-rc.1_x64-setup.exe")),
    });
    const { instance } = updater({ gh });
    const check = await instance.check("prerelease");
    expect(check).toMatchObject({
      available: true,
      channel: "prerelease",
      latestVersion: "1.5.0-rc.1",
      tag: "v1.5.0-rc.1",
      htmlUrl: "",
      canSelfInstall: true,
    });
    expect(check.releases?.map((r) => r.relation)).toEqual(["newer", "current", "older"]);
    expect(calls.filter((c) => c[1] === "view")).toEqual([
      [
        "release",
        "view",
        "v1.5.0-rc.1",
        "--repo",
        "ANT1OFF/gram",
        "--json",
        "tagName,isDraft,assets",
      ],
    ]);
    expect(calls.find((c) => c[1] === "list")).toContain("ANT1OFF/gram");
  });

  it("holds back releases the Windows installer hasn't reached yet, and offers each once it has", async () => {
    const attached: Record<string, string[]> = {
      "v1.5.0-rc.1": ["gram_1.5.0-rc.1_arm64.pkg", "SHA256SUMS"],
      "v1.4.0": ["gram_1.4.0_arm64.pkg", "SHA256SUMS"],
    };
    const { gh, calls } = fakeGh({
      "auth status": () => ok(),
      "release list": () => ok(releases),
      "release view": (args) => ok(assets(...(attached[args[2]!] ?? []))),
    });
    const { instance, warnings } = updater({ gh, currentVersion: "1.3.0" });
    const waiting = await instance.check("prerelease");
    expect(waiting).toMatchObject({ available: false, channel: "prerelease" });
    expect(waiting.unavailable).toBeUndefined();
    expect(waiting.releases?.map((r) => r.tag)).toEqual(["v1.3.0"]);
    expect(calls.filter((c) => c[1] === "view").map((c) => c[2])).toEqual([
      "v1.5.0-rc.1",
      "v1.4.0",
    ]);
    expect(warnings).toEqual([]);

    attached["v1.4.0"]!.push("gram_1.4.0_x64-setup.exe");
    // Another release's installer, or one named for nothing, doesn't count as this one's.
    attached["v1.5.0-rc.1"]!.push("gram_1.4.0_x64-setup.exe", "Gram-setup.exe");
    expect(await instance.check("prerelease")).toMatchObject({ available: true, tag: "v1.4.0" });

    attached["v1.5.0-rc.1"]!.push("gram_1.5.0-rc.1_x64-setup.exe");
    const both = await instance.check("prerelease");
    expect(both).toMatchObject({ available: true, tag: "v1.5.0-rc.1" });
    expect(both.releases?.map((r) => r.tag)).toEqual(["v1.5.0-rc.1", "v1.4.0", "v1.3.0"]);
  });

  it("is unavailable when it can't tell whether the installer is there", async () => {
    for (const view of [() => failed("HTTP 502"), () => ok("{}")]) {
      const { gh } = fakeGh({
        "auth status": () => ok(),
        "release list": () => ok(releases),
        "release view": view,
      });
      const { instance, warnings } = updater({ gh });
      expect(await instance.check("prerelease")).toMatchObject({
        available: false,
        unavailable: true,
      });
      expect(warnings).toHaveLength(1);
    }
  });

  it("links the release page on macOS", async () => {
    const { gh } = fakeGh({
      "auth status": () => ok(),
      "release list": () => ok(releases),
      "release view": () =>
        ok(JSON.stringify({ url: "https://github.com/x/y/releases/tag/v1.5.0-rc.1" })),
    });
    const { instance } = updater({ gh, platform: "darwin" });
    expect(await instance.check("prerelease")).toMatchObject({
      available: true,
      canSelfInstall: false,
      htmlUrl: "https://github.com/x/y/releases/tag/v1.5.0-rc.1",
    });
  });

  it("reports up to date with the list still present, for downgrades", async () => {
    const { gh } = fakeGh({ "auth status": () => ok(), "release list": () => ok(releases) });
    const { instance } = updater({ gh });
    const check = await instance.check("stable");
    expect(check).toMatchObject({ available: false, channel: "stable" });
    expect(check.unavailable).toBeUndefined();
    expect(check.releases?.map((r) => r.tag)).toEqual(["v1.4.0", "v1.3.0"]);
  });

  it("says nothing of its own when gh isn't signed in: the page words what it needs", async () => {
    const { gh: loggedOut } = fakeGh({ "auth status": () => failed("not logged in") });
    const check = await updater({ gh: loggedOut }).instance.check("stable");
    expect(check.unavailable).toBe(true);
    expect(check.unavailableMessage).toBeUndefined();
  });
});

const intent = (tag: string, downgrade = false, channel: UpdateChannel = "stable") => ({
  channel,
  tag,
  downgrade,
});

/** `gh release download` writing `files` into `--dir`, or the `--pattern` asset by default. */
const download =
  (files?: readonly string[]) =>
  (args: readonly string[]): ProcessResult => {
    const dir = args[args.indexOf("--dir") + 1]!;
    for (const file of files ?? [args[args.indexOf("--pattern") + 1]!]) {
      writeFileSync(join(dir, file), "stub");
    }
    return ok();
  };

const updateDirs = () => readdirSync(tempDir).filter((n) => n.startsWith(UPDATE_DIR_PREFIX));

describe("downloadAndVerify", () => {
  const feed = JSON.stringify([
    { tagName: "v1.7.0", isDraft: true },
    { tagName: "v1.6.0-rc.1", isDraft: false },
    { tagName: "v1.5.0", isDraft: false },
    { tagName: "v1.4.1", isDraft: false },
    { tagName: "v1.4.0", isDraft: false },
    { tagName: "v1.3.0", isDraft: false },
  ]);
  /** Each release as published, with its own installer; `view` overrides what a tag says. */
  const releaseGh = (
    view: (tag: string) => Record<string, unknown> = () => ({}),
    respond: Record<string, (args: readonly string[]) => ProcessResult> = {},
  ) =>
    fakeGh({
      "auth status": () => ok(),
      "release list": () => ok(feed),
      "release view": (args) => {
        const tag = args[2]!;
        const name = `gram_${tag.slice(1)}_x64-setup.exe`;
        return ok(
          JSON.stringify({
            tagName: tag,
            isDraft: false,
            assets: [{ name }, { name: "SHA256SUMS" }],
            ...view(tag),
          }),
        );
      },
      "release download": download(),
      ...respond,
    });
  it("downloads exactly the tag's installer, verifies it and reports progress", async () => {
    const { gh, calls } = releaseGh();
    const { instance } = updater({ gh });
    const progress: UpdateProgress[] = [];
    const installer = await instance.downloadAndVerify(intent("v1.5.0"), (p) => progress.push(p));
    expect(installer).toMatch(new RegExp(`${UPDATE_DIR_PREFIX}.+gram_1\\.5\\.0_x64-setup\\.exe$`));
    expect(existsSync(installer)).toBe(true);
    expect(progress.map((p) => p.stage)).toEqual(["downloading", "verifying"]);
    expect(calls.find((c) => c[1] === "download")).toEqual(
      expect.arrayContaining(["--pattern", "gram_1.5.0_x64-setup.exe"]),
    );
  });

  it("refuses when the saved channel isn't the one the release was picked on", async () => {
    const { gh, calls } = releaseGh();
    const { instance } = updater({ gh, readPrefs: async () => ({ channel: "prerelease" }) });
    await expect(instance.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(
      "saved release channel is Pre-release, not Stable",
    );
    expect(calls.filter((c) => c[1] === "download")).toEqual([]);
  });

  it("installs only a published release of the channel", async () => {
    for (const tag of ["v1.6.0-rc.1", "v1.7.0", "v9.9.9"]) {
      const { gh, calls } = releaseGh();
      const { instance } = updater({ gh });
      await expect(
        instance.downloadAndVerify(intent(tag), () => {}),
        tag,
      ).rejects.toThrow(`${tag} isn't a published Stable release`);
      expect(calls.filter((c) => c[1] === "download")).toEqual([]);
    }
    const { gh } = releaseGh();
    const prerelease = updater({ gh, readPrefs: async () => ({ channel: "prerelease" }) });
    await expect(
      prerelease.instance.downloadAndVerify(intent("v1.6.0-rc.1", false, "prerelease"), () => {}),
    ).resolves.toMatch(/gram_1\.6\.0-rc\.1_x64-setup\.exe$/);
  });

  it("installs an older release only as an explicit downgrade, and a newer one never as one", async () => {
    const { gh } = releaseGh();
    const { instance } = updater({
      gh,
      readPrefs: async () => ({ channel: "stable", pinnedVersion: "1.3.0" }),
    });
    await expect(instance.downloadAndVerify(intent("v1.3.0"), () => {})).rejects.toThrow(
      "older than 1.4.0: install it as a downgrade",
    );
    await expect(instance.downloadAndVerify(intent("v1.5.0", true), () => {})).rejects.toThrow(
      "newer than 1.4.0, not a downgrade",
    );
    await expect(instance.downloadAndVerify(intent("v1.4.0", true), () => {})).rejects.toThrow(
      "already installed",
    );
    await expect(instance.downloadAndVerify(intent("v1.3.0", true), () => {})).resolves.toMatch(
      /gram_1\.3\.0_x64-setup\.exe$/,
    );
  });

  it("installs anything but the channel's newest release only once it's the saved pin", async () => {
    for (const [tag, downgrade] of [
      ["v1.4.1", false],
      ["v1.3.0", true],
    ] as const) {
      const { gh } = releaseGh();
      const unpinned = updater({ gh }).instance;
      await expect(unpinned.downloadAndVerify(intent(tag, downgrade), () => {})).rejects.toThrow(
        "isn't the newest release and isn't pinned",
      );
      const pinnedVersion = tag.slice(1);
      const pinned = updater({ gh, readPrefs: async () => ({ channel: "stable", pinnedVersion }) });
      await expect(
        pinned.instance.downloadAndVerify(intent(tag, downgrade), () => {}),
      ).resolves.toContain(pinnedVersion);
    }
  });

  it("takes a pre-release back to the newest stable release without a pin", async () => {
    const { gh } = releaseGh();
    const { instance } = updater({ gh, currentVersion: "1.6.0-rc.1" });
    await expect(instance.downloadAndVerify(intent("v1.5.0", true), () => {})).resolves.toMatch(
      /gram_1\.5\.0_x64-setup\.exe$/,
    );
  });

  it("checks the release again right before downloading it", async () => {
    for (const [view, error] of [
      [{ isDraft: true }, "v1.5.0 is not a published release"],
      [{ isDraft: undefined }, "v1.5.0 is not a published release"],
      [{ tagName: "v1.4.0" }, "v1.5.0 is not a published release"],
      [{ assets: [{ name: "gram_1.4.0_x64-setup.exe" }] }, "has no gram_1.5.0"],
    ] as const) {
      // v1.5.0 is viewed first among the list's newer releases, as `check` does; again to recheck.
      let views = 0;
      const { gh, calls } = releaseGh((tag) => (tag === "v1.5.0" && ++views > 1 ? view : {}));
      const { instance } = updater({ gh });
      await expect(instance.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(error);
      expect(calls.filter((c) => c[1] === "download")).toEqual([]);
    }
  });

  it("refuses a download that isn't exactly the one installer, and removes it", async () => {
    for (const files of [[], ["gram_1.5.0_x64-setup.exe", "other-setup.exe"], ["Gram-setup.exe"]]) {
      const { gh } = releaseGh(undefined, { "release download": download(files) });
      const { instance } = updater({ gh });
      await expect(instance.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(
        "expected only gram_1.5.0_x64-setup.exe",
      );
      expect(updateDirs()).toEqual([]);
    }
  });

  it("rejects a bad signature, or another product or version under a good one", async () => {
    for (const [probe, error] of [
      [ok("STATUS=NotSigned\n"), "NotSigned"],
      [probeOf("1.4.0"), "installer is version 1.4.0, not the release's 1.5.0"],
      [probeOf(""), "installer is version unknown"],
      [probeOf("1.5.0", "Other Tool"), "installer is not Gram (product: Other Tool)"],
    ] as const) {
      const { gh } = releaseGh();
      const { instance, warnings } = updater({ gh, probeSignature: async () => probe });
      await expect(instance.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(error);
      expect(updateDirs()).toEqual([]);
      expect(warnings[0]).toContain("signature probe refused");
    }
  });

  it("rejects a failed download or release list", async () => {
    const failedDownload = releaseGh(undefined, { "release download": () => failed("HTTP 404") });
    await expect(
      updater({ gh: failedDownload.gh }).instance.downloadAndVerify(intent("v1.5.0"), () => {}),
    ).rejects.toThrow("download failed: HTTP 404");
    expect(readdirSync(tempDir)).toEqual([]);

    const failedList = releaseGh(undefined, { "release list": () => failed("HTTP 502") });
    await expect(
      updater({ gh: failedList.gh }).instance.downloadAndVerify(intent("v1.5.0"), () => {}),
    ).rejects.toThrow("couldn't list the releases");
  });

  it("refuses to download without the free space an update needs, before downloading", async () => {
    const { gh, calls } = releaseGh();
    const { instance } = updater({ gh, freeBytes: async () => 300 * 1024 * 1024 });
    await expect(instance.downloadAndVerify(intent("v1.5.0"), () => {})).rejects.toThrow(
      /^There isn't enough free disk space to update: 300 MB free on the disk holding .+, and an update needs 1\.0 GB\. Free some space and try again\.$/,
    );
    expect(calls.filter((c) => c[1] === "download")).toEqual([]);
    expect(readdirSync(tempDir)).toEqual([]);

    const roomy = updater({ gh: releaseGh().gh, freeBytes: async () => 2 * 1024 ** 3 });
    await expect(roomy.instance.downloadAndVerify(intent("v1.5.0"), () => {})).resolves.toMatch(
      /gram_1\.5\.0_x64-setup\.exe$/,
    );
  });

  it("reads the free space of a real directory", async () => {
    expect(await statfsFreeBytes(tmpdir())).toBeGreaterThan(0);
    expect(await statfsFreeBytes(join(tmpdir(), "no-such-dir-gram-updater"))).toBeUndefined();
  });

  it("refuses before touching gh off Windows or with a bad tag", async () => {
    const { gh, calls } = fakeGh({});
    await expect(
      updater({ gh, platform: "darwin" }).instance.downloadAndVerify(intent("v1.5.0"), () => {}),
    ).rejects.toThrow("Windows-only");
    await expect(
      updater({ gh }).instance.downloadAndVerify(intent("v1.5.0 --repo evil/x"), () => {}),
    ).rejects.toThrow("not a release tag");
    expect(calls).toEqual([]);
  });
});

describe("unavailableUpdater", () => {
  it("answers every check unavailable with its reason and never installs", async () => {
    const instance = unavailableUpdater("1.4.0", "This build doesn't update itself.");
    expect(instance.canSelfInstall).toBe(false);
    for (const channel of ["stable", "prerelease"] as const) {
      expect(await instance.check(channel)).toEqual({
        available: false,
        unavailable: true,
        unavailableMessage: "This build doesn't update itself.",
        currentVersion: "1.4.0",
        canSelfInstall: false,
        channel,
      });
    }
    const progress: UpdateProgress[] = [];
    await expect(
      instance.downloadAndVerify({ channel: "stable", tag: "v1.5.0", downgrade: false }, (p) =>
        progress.push(p),
      ),
    ).rejects.toThrow("This build doesn't update itself.");
    expect(progress).toEqual([]);
  });
});
