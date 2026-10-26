#!/usr/bin/env node
// Signs a packaged Gram.app with the publisher's Developer ID, notarizes and staples it, then
// verifies it the way Gatekeeper and Gram's updater will. Packaging stays unsigned
// (electron-builder.yml `identity: null`), so check, build and smoke keep their isolated HOME;
// this step alone runs with your own login keychain.
//
//   node scripts/sign-mac.mjs --app <Gram.app> --identity "Developer ID Application: Name (TEAMID)"
//                             --notary-profile <notarytool keychain profile> [--keychain <path>]
//   node scripts/sign-mac.mjs --app <Gram.app> --adhoc        # hardened-runtime rehearsal only
//
// Credentials are named, never read: the identity by its Keychain name and notarization by a
// profile you made with `xcrun notarytool store-credentials`. The last stdout line is a JSON
// summary without paths. Exits nonzero on any refusal.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTITLEMENTS = join(HERE, "../build/entitlements.mac.plist");
const signature = await import(
  pathToFileURL(join(HERE, "../../../packages/shell/src/modules/update/mac-signature.ts")).href
);
const {
  GRAM_MAC_TEAM_ID,
  developerIdTeam,
  macDesignatedRequirement,
  macRequirementSha256,
  parseCodesignDisplay,
  parseGatekeeper,
  parseStaple,
  requireMacCodeSignature,
} = signature;

const say = (line) => process.stderr.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`sign-mac: ${message}\n`);
  process.exit(1);
};
/** Absolute tools only; nothing is resolved from PATH. */
const tool = (file, args, options = {}) => {
  const r = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 ** 2, ...options });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
};

function parseArgs(argv) {
  const options = { adhoc: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--app") options.app = resolve(value());
    else if (arg === "--identity") options.identity = value();
    else if (arg === "--notary-profile") options.profile = value();
    else if (arg === "--keychain") options.keychain = resolve(value());
    else if (arg === "--adhoc") options.adhoc = true;
    else fail(`unknown argument ${arg}.`);
  }
  if (!options.app || basename(options.app) !== "Gram.app" || !existsSync(options.app))
    fail("--app must name an existing Gram.app.");
  if (options.adhoc === Boolean(options.identity))
    fail("pass exactly one of --identity <Developer ID name> or --adhoc.");
  if (!options.adhoc && !options.profile)
    fail("a Developer ID build must be notarized: pass --notary-profile <name>.");
  if (options.adhoc && options.profile) fail("an ad-hoc rehearsal cannot be notarized.");
  return options;
}

const MACHO = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"]);
/** Only Mach-O files and bundles are code; resources stay sealed by the app's CodeResources. */
function isCode(file) {
  const stat = lstatSync(file);
  if (!stat.isFile()) return true;
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO.has(head.toString("hex"));
  } finally {
    closeSync(fd);
  }
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "darwin") fail("signing needs macOS.");
const teamId = options.adhoc ? null : developerIdTeam(options.identity);
if (!options.adhoc) {
  if (!teamId) fail('--identity must be "Developer ID Application: <Name> (<TEAMID>)".');
  if (teamId !== GRAM_MAC_TEAM_ID)
    fail(
      `the identity's team ${teamId} is not GRAM_MAC_TEAM_ID (${GRAM_MAC_TEAM_ID ?? "unset"}) in ` +
        "packages/shell/src/modules/update/mac-signature.ts; the updater would refuse this build.",
    );
  // Lists names and hashes only, never key material.
  const identities = tool("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    ...(options.keychain ? [options.keychain] : []),
  ]);
  if (identities.status !== 0 || !identities.stdout.includes(`"${options.identity}"`))
    fail(
      `no valid "${options.identity}" in the keychain (security find-identity -v -p codesigning).`,
    );
}

// ---------------------------------------------------------------------------------------------
// Sign inside out with the @electron/osx-sign electron-builder itself pins, every nested Mach-O
// (Electron's helpers and frameworks, node-pty's spawn-helper and addon, the speech addon and its
// ONNX Runtime dylibs) with the hardened runtime and the one reviewed entitlements file.
const begin = Date.now();
// Library validation admits only code from the app's own team. Ad-hoc code has no team, so the
// rehearsal alone adds the exception; a Developer ID build signs every nested binary as one team.
let entitlements = ENTITLEMENTS;
const rehearsal = options.adhoc ? mkdtempSync(join(tmpdir(), "gram-adhoc-")) : undefined;
if (rehearsal) {
  entitlements = join(rehearsal, "entitlements.plist");
  writeFileSync(
    entitlements,
    readFileSync(ENTITLEMENTS, "utf8").replace(
      "  </dict>",
      "    <key>com.apple.security.cs.disable-library-validation</key>\n    <true/>\n  </dict>",
    ),
  );
}
const builderRequire = createRequire(
  createRequire(import.meta.url).resolve("app-builder-lib/package.json"),
);
const { signAsync } = builderRequire("@electron/osx-sign");
say(`signing ${options.adhoc ? "ad hoc" : `with team ${teamId}`} …`);
await signAsync({
  app: options.app,
  identity: options.adhoc ? "-" : options.identity,
  identityValidation: false,
  platform: "darwin",
  type: "distribution",
  ...(options.keychain ? { keychain: options.keychain } : {}),
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
  ignore: (file) => !isCode(file),
  optionsForFile: () => ({
    hardenedRuntime: true,
    entitlements,
    // A secure timestamp is required for notarization; ad-hoc signatures cannot carry one.
    ...(options.adhoc ? { timestamp: "none" } : {}),
  }),
});
if (rehearsal) rmSync(rehearsal, { recursive: true, force: true });
const signedSeconds = Math.round((Date.now() - begin) / 1000);

const verify = tool("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  options.app,
]);
if (verify.status !== 0) fail(`codesign --verify --deep --strict failed:\n${verify.stderr}`);
const display = parseCodesignDisplay(
  tool("/usr/bin/codesign", ["--display", "--verbose=2", options.app]).stderr,
);
if (!display.hardenedRuntime) fail("the signed app lacks the hardened runtime flag.");

const summary = {
  signing: options.adhoc ? "ad-hoc" : "developer-id",
  identifier: display.identifier,
  teamId: display.teamId,
  hardenedRuntime: display.hardenedRuntime,
  signSeconds: signedSeconds,
  codesignVerify: "pass: codesign --verify --deep --strict",
};

if (!options.adhoc) {
  // -----------------------------------------------------------------------------------------
  // Notarize the exact signed bytes, staple the ticket, then assess as Gatekeeper and the updater.
  const scratch = mkdtempSync(join(tmpdir(), "gram-notarize-"));
  try {
    const zip = join(scratch, "Gram.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", options.app, zip]);
    say("notarizing (notarytool submit --wait) …");
    const keychain = options.keychain ? ["--keychain", options.keychain] : [];
    const submit = tool("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      options.profile,
      ...keychain,
      "--wait",
      "--timeout",
      "1h",
      "--output-format",
      "json",
    ]);
    let result;
    try {
      result = JSON.parse(submit.stdout);
    } catch {
      fail(`notarytool submit failed (exit ${submit.status}):\n${submit.stderr || submit.stdout}`);
    }
    if (result.status !== "Accepted") {
      const log = result.id
        ? tool("/usr/bin/xcrun", [
            "notarytool",
            "log",
            result.id,
            "--keychain-profile",
            options.profile,
            ...keychain,
          ]).stdout
        : "";
      fail(
        `notarization ${result.status ?? "failed"} (submission ${result.id ?? "none"}):\n${log}`,
      );
    }
    summary.notarization = { submissionId: result.id, status: result.status };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const staple = tool("/usr/bin/xcrun", ["stapler", "staple", options.app]);
  if (staple.status !== 0) fail(`stapler staple failed:\n${staple.stdout}\n${staple.stderr}`);
  const validate = tool("/usr/bin/xcrun", ["stapler", "validate", options.app]);
  if (validate.status !== 0)
    fail(`stapler validate failed:\n${validate.stdout}\n${validate.stderr}`);
  summary.stapled = true;
  summary.staplerValidate = "pass: xcrun stapler validate";

  const requirement = tool("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    `=${macDesignatedRequirement(teamId)}`,
    options.app,
  ]);
  const assessment = tool("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    options.app,
  ]);
  const gatekeeper = parseGatekeeper(
    assessment.status,
    `${assessment.stdout}\n${assessment.stderr}`,
  );
  try {
    requireMacCodeSignature(
      {
        requirement:
          requirement.status === 0
            ? "satisfied"
            : requirement.status === 3
              ? "unsatisfied"
              : "invalid",
        identifier: display.identifier,
        teamId: display.teamId,
        hardenedRuntime: display.hardenedRuntime,
        gatekeeper,
        staple: parseStaple(validate.status, `${validate.stdout}\n${validate.stderr}`),
      },
      teamId,
    );
  } catch (error) {
    fail(`${error.message}\n${requirement.stderr}\n${assessment.stderr}`);
  }
  summary.requirementSha256 = macRequirementSha256(teamId);
  summary.designatedRequirement =
    "pass: codesign --verify --deep --strict -R=<Gram's Developer ID requirement>";
  summary.gatekeeper = `pass: spctl --assess --type execute: accepted, source=${gatekeeper}`;
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
