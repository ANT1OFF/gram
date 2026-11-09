import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { joinedOverSsh } from "../http/machine-routes.ts";
import { fingerprintOf, generateHostKey } from "./machine-keys.ts";
import {
  printedFingerprint,
  readableOutput,
  runOverSsh,
  sshConfigHosts,
  SSH_TARGET,
} from "./ssh-join.ts";

/** An `ssh` that records its arguments and stdin, prints `say` and exits with `code`. */
const fakeSsh = (dir: string, say: string, code = 0) => {
  const path = join(dir, "ssh");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$@" >"${dir}/args"
cat >"${dir}/stdin"
printf '%s\\n' '${say}'
exit ${code}
`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** Installer output that printed `key`'s fingerprint. */
const said = (key: { publicKey: string }) => `x\nFingerprint: ${fingerprintOf(key.publicKey)}\n`;

describe("adding a machine over SSH", () => {
  it.effect("sends the installer on stdin, with only keys and never an option for a host", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      try {
        const ssh = fakeSsh(dir, "Fingerprint: 0123-4567-89AB-CDEF-0123");
        const output = yield* runOverSsh("me@build-box", "echo installer", { ssh });
        expect(printedFingerprint(output)).toBe("0123-4567-89AB-CDEF-0123");
        const args = readFileSync(join(dir, "args"), "utf8").split("\n");
        expect(args).toContain("BatchMode=yes");
        expect(args.indexOf("--")).toBe(args.indexOf("me@build-box") - 1);
        expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("echo installer");
      } finally {
        removeDir(dir);
      }
    }),
  );

  it.effect("says why it couldn't connect, and refuses what would be an ssh option", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      try {
        const ssh = fakeSsh(dir, "Permission denied (publickey).", 255);
        const refused = yield* runOverSsh("build-box", "true", { ssh }).pipe(Effect.flip);
        expect(refused.message).toContain("never a password");
        expect(refused.output).toContain("Permission denied");
        for (const target of ["-oProxyCommand=touch /tmp/x", "a b", "me@-x", "host;rm"]) {
          expect(SSH_TARGET.test(target)).toBe(false);
          const bad = yield* runOverSsh(target, "true", { ssh }).pipe(Effect.flip);
          expect(bad.message).toBe("That isn't a host to SSH to.");
        }
      } finally {
        removeDir(dir);
      }
    }),
  );

  it("confirms only the new machine whose key the install printed", () => {
    const old = generateHostKey();
    const fresh = generateHostKey();
    const other = generateHostKey();
    const machines = [
      { id: "m-old", publicKey: old.publicKey },
      { id: "m-other", publicKey: other.publicKey },
      { id: "m-new", publicKey: fresh.publicKey },
    ];
    expect(joinedOverSsh(new Set(["m-old"]), machines, said(fresh))).toBe(machines[2]);
    // A machine already here that printed its key is not a new join.
    expect(joinedOverSsh(new Set(["m-old"]), machines, said(old))).toBeUndefined();
    expect(joinedOverSsh(new Set(["m-old"]), [machines[0]!], said(fresh))).toBeUndefined();
    expect(joinedOverSsh(new Set(), machines, "moved its service")).toBe("rejoined");
  });

  it("keeps the session's words, without colour codes or progress bars", () => {
    expect(
      readableOutput(
        "\u001b[32mgram-host: Downloading\u001b[0m\n##### 10.0%\r###### 55.5%\r\nFingerprint: X\n\n",
      ),
    ).toBe("gram-host: Downloading\nFingerprint: X");
  });

  it("lists the SSH config's own hosts, never its patterns", () => {
    const home = tempDir();
    try {
      mkdirSync(join(home, ".ssh"));
      writeFileSync(
        join(home, ".ssh", "config"),
        "Host build-box studio\n  HostName 10.0.0.2\nHost *.internal !bad\nhost lower\nMatch all\n",
      );
      expect(sshConfigHosts(home)).toEqual(["build-box", "studio", "lower"]);
      expect(sshConfigHosts(join(home, "missing"))).toEqual([]);
    } finally {
      removeDir(home);
    }
  });
});
