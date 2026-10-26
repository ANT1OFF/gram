import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createUpdater,
  createUpdateService,
  EXPECTED_SIGNER_CERT_SHA256,
  UPDATE_DIR_PREFIX,
  type ProcessResult,
  type RunGh,
} from "@gram/shell/modules/update";

import { probeSignature } from "./process.ts";

// The Windows install path end to end: a local fake release feed stands in for `gh`, and the real
// Authenticode probe (Windows PowerShell) checks stub installers against the pin, and their version
// resource against the tag. The stubs are copies of Node's own executable, so a genuine one is
// released at Node's version and checked for Node's product name. The installer
// spawn is recorded and exit is a spy, so nothing is launched, installed or replaced. Opt in with
// GRAM_WIN_UPDATER_E2E=1 on Windows; CI runs it on windows-latest.
const E2E = process.platform === "win32" && process.env["GRAM_WIN_UPDATER_E2E"] === "1";
const TIMEOUT_MS = 180_000;

const ok = (stdout = ""): ProcessResult => ({ status: 0, stdout, stderr: "" });

let root: string;
let feed: string;
let tempDir: string;

/** `gh` over a folder of `<tag>/<asset>` files. */
const feedGh: RunGh = async (args) => {
  const [command, subcommand, tag] = args;
  if (command === "auth") return ok();
  if (command === "release" && subcommand === "list") {
    const tags = readdirSync(feed).map((tagName) => ({
      tagName,
      isDraft: false,
    }));
    return ok(JSON.stringify(tags));
  }
  if (command === "release" && subcommand === "view" && tag !== undefined) {
    const assets = readdirSync(join(feed, tag)).map((name) => ({ name }));
    return ok(JSON.stringify({ tagName: tag, isDraft: false, assets }));
  }
  if (command === "release" && subcommand === "download" && tag !== undefined) {
    const dir = args[args.indexOf("--dir") + 1]!;
    const pattern = args[args.indexOf("--pattern") + 1];
    for (const asset of readdirSync(join(feed, tag))) {
      if (asset === pattern) copyFileSync(join(feed, tag, asset), join(dir, asset));
    }
    return ok();
  }
  return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
};

const updater = ({
  signer,
  product,
  pinnedVersion,
}: { signer?: string; product?: string; pinnedVersion?: string } = {}) =>
  createUpdater({
    gh: feedGh,
    repo: "ANT1OFF/gram",
    currentVersion: "1.0.0",
    platform: "win32",
    tempDir,
    probeSignature,
    readPrefs: async () => ({ channel: "stable", pinnedVersion }),
    warn: () => {},
    ...(signer === undefined ? {} : { expectedSignerSha256: signer }),
    ...(product === undefined ? {} : { expectedProductName: product }),
  });

const intent = (tag: string) => ({ channel: "stable" as const, tag, downgrade: false });

/** The signer fingerprint of Node's own executable, which the stubs are copies of. */
let nodePin: string;
/** Node's version, as its executable's version resource says it. */
let nodeVersion: string;
/** A version past Node's, released with a copy of Node: genuinely signed, but not that release. */
let nextVersion: string;
/** What a stub copied from Node passes as, under the pin and product it's checked against. */
const asNode = (pinnedVersion?: string) =>
  updater({ signer: nodePin, product: "Node.js", ...(pinnedVersion ? { pinnedVersion } : {}) });

const release = (version: string, contents: Buffer) => {
  mkdirSync(join(feed, `v${version}`));
  writeFileSync(join(feed, `v${version}`, `gram_${version}_x64-setup.exe`), contents);
};

const updateDirs = () => readdirSync(tempDir).filter((n) => n.startsWith(UPDATE_DIR_PREFIX));

describe.skipIf(!E2E)("Windows update install path", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "gram-win-update-"));
    feed = join(root, "feed");
    tempDir = join(root, "tmp");
    mkdirSync(feed);
    mkdirSync(tempDir);

    const probe = await probeSignature(process.execPath);
    expect(probe.stdout, probe.stderr).toContain("STATUS=Valid");
    nodePin = /SHA256=([0-9A-F]+)/i.exec(probe.stdout)?.[1] ?? "";
    expect(nodePin).toMatch(/^[0-9A-F]{64}$/i);
    expect(probe.stdout).toMatch(/^PRODUCT=Node\.js\s*$/m);
    nodeVersion = /^VERSION=(\d+\.\d+\.\d+)\s*$/m.exec(probe.stdout)?.[1] ?? "";
    expect(nodeVersion).not.toBe("");
    nextVersion = `${Number(nodeVersion.split(".")[0]) + 1}.0.0`;

    const node = readFileSync(process.execPath);
    const tampered = Buffer.from(node);
    const middle = Math.floor(tampered.length / 2);
    tampered[middle] = tampered[middle]! ^ 0xff;
    release(nodeVersion, node);
    release(nextVersion, node);
    release("1.2.0", Buffer.from("MZ unsigned stub"));
    release("1.3.0", tampered);
  }, TIMEOUT_MS);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it(
    "lists the feed and offers the newest release",
    async () => {
      const check = await updater().check("stable");
      expect(check).toMatchObject({
        available: true,
        tag: `v${nextVersion}`,
        canSelfInstall: true,
      });
      expect(check.releases?.map((r) => r.tag)).toEqual([
        `v${nextVersion}`,
        `v${nodeVersion}`,
        "v1.3.0",
        "v1.2.0",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "accepts an installer only when its signer matches the pin",
    async () => {
      const tag = `v${nodeVersion}`;
      const installer = await asNode(nodeVersion).downloadAndVerify(intent(tag), () => {});
      expect(existsSync(installer)).toBe(true);

      expect(nodePin.toUpperCase()).not.toBe(EXPECTED_SIGNER_CERT_SHA256);
      const before = updateDirs().length;
      await expect(
        updater({ product: "Node.js", pinnedVersion: nodeVersion }).downloadAndVerify(
          intent(tag),
          () => {},
        ),
      ).rejects.toThrow("unexpected certificate");
      expect(updateDirs()).toHaveLength(before);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses an unsigned or tampered installer even under a matching pin",
    async () => {
      for (const version of ["1.2.0", "1.3.0"]) {
        const before = updateDirs().length;
        await expect(
          asNode(version).downloadAndVerify(intent(`v${version}`), () => {}),
        ).rejects.toThrow("installer signature is not valid");
        expect(updateDirs()).toHaveLength(before);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "refuses a genuinely signed installer of another release or another product",
    async () => {
      const before = updateDirs().length;
      await expect(asNode().downloadAndVerify(intent(`v${nextVersion}`), () => {})).rejects.toThrow(
        `installer is version ${nodeVersion}, not the release's ${nextVersion}`,
      );
      await expect(
        updater({ signer: nodePin, pinnedVersion: nodeVersion }).downloadAndVerify(
          intent(`v${nodeVersion}`),
          () => {},
        ),
      ).rejects.toThrow("installer is not Gram (product: Node.js)");
      expect(updateDirs()).toHaveLength(before);
    },
    TIMEOUT_MS,
  );

  it(
    "hands the verified installer to restart-to-update without launching it",
    async () => {
      const calls: string[] = [];
      let launched: string | undefined;
      const service = createUpdateService({
        updater: asNode(nodeVersion),
        stopServer: async () => void calls.push("stopServer"),
        restartServer: async () => void calls.push("restartServer"),
        broadcast: (p) => void calls.push(p.stage),
        hideWindows: () => {
          calls.push("hide");
          return () => void calls.push("show");
        },
        exit: () => void calls.push("exit"),
        spawnInstaller: async (installer) => {
          launched = installer;
          calls.push("spawn");
        },
        exitDelayMs: 0,
      });

      expect(await service.install(intent(`v${nodeVersion}`))).toEqual({ updating: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual([
        "downloading",
        "verifying",
        "installing",
        "hide",
        "stopServer",
        "spawn",
        "exit",
      ]);
      expect(launched?.endsWith(`gram_${nodeVersion}_x64-setup.exe`)).toBe(true);
      expect(existsSync(launched!)).toBe(true);
    },
    TIMEOUT_MS,
  );
});
