import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openSsl3 } from "@gram/git/openssl-testing";
import { afterAll, describe, expect, it } from "vitest";
import { removeDir, tempDir } from "../git/test-repo.ts";
import {
  type InstallTrust,
  installCommand,
  installScript,
  RELEASES,
  updateCommand,
} from "./install-script.ts";
import { LINUX_HOST_SWITCHES } from "./launch-args.ts";

const ORIGIN = "https://studio.example-tailnet.ts.net";
const LINK = `${ORIGIN}/host/join#code=${"a".repeat(64)}`;

const executable = (path: string, text: string) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

/** A throwaway publisher release key, made for these tests, and another that forges. */
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    key: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
    sign: (bytes: Buffer) => sign(null, bytes, privateKey).toString("base64"),
  };
};
const publisher = keyPair();
const forger = keyPair();

/**
 * Stand-ins for Apple's codesign and spctl (macOS can't run here): they pass unless
 * SYNTHETIC_CODESIGN or SYNTHETIC_SPCTL names another exit, and codesign keeps what it was asked.
 */
const apple = tempDir();
afterAll(() => removeDir(apple));
executable(
  join(apple, "codesign"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >>"${apple}/asked"\nexit "\${SYNTHETIC_CODESIGN:-0}"\n`,
);
executable(join(apple, "spctl"), `#!/bin/sh\nexit "\${SYNTHETIC_SPCTL:-0}"\n`);
const TRUST: InstallTrust = {
  releaseKey: publisher.key,
  macTeam: "FAKETEAM01",
  codesign: join(apple, "codesign"),
  spctl: join(apple, "spctl"),
};
const script = (
  version: string | undefined,
  run: Parameters<typeof installScript>[2] = {},
  trust: Partial<InstallTrust> = {},
) => installScript(ORIGIN, version, run, { ...TRUST, ...trust });

const OPENSSL = openSsl3();

/**
 * A synthetic machine with no Gram on it: `curl` serves the release from a folder, and the release's
 * AppImage unpacks to a `gram` that runs its entry with Node and a `gram-host.js` that records
 * how it was run.
 */
const machine = (
  version: string,
  tamper = false,
  platform = "Linux",
  signature: "publisher" | "forged" | "none" = "publisher",
) => {
  const dir = tempDir();
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const release = join(dir, "release");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  mkdirSync(release);
  const record = join(dir, "ran.json");
  const image =
    platform === "Darwin"
      ? `gram_${version}_darwin-arm64_signed.zip`
      : `gram_${version}_x86_64.AppImage`;
  executable(
    join(release, image),
    `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 9
mkdir -p squashfs-root/resources/app.asar/out/server
cat >squashfs-root/gram <<'GRAM'
#!/bin/sh
[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 8
exec node "$@"
GRAM
chmod +x squashfs-root/gram
if [ -n "\${SYNTHETIC_UNPACK_SIGNAL:-}" ]; then kill -s "$SYNTHETIC_UNPACK_SIGNAL" "$PPID"; exit 23; fi
[ "\${SYNTHETIC_UNPACK_FAIL:-}" != 1 ] || exit 23
cat >squashfs-root/resources/app.asar/out/server/gram-host.js <<'HOST'
const { appendFileSync, readFileSync } = require("node:fs");
if (process.argv[2] === "--help") process.exit(0);
// As the real one does, Chromium's switches aren't its arguments; the switches it was given are kept.
const switches = process.argv.slice(2).filter((arg) => ${JSON.stringify(LINUX_HOST_SWITCHES)}.includes(arg));
const args = process.argv.slice(2).filter((arg) => !switches.includes(arg));
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, stdin: readFileSync(0, "utf8"), switches }) + "\\n");
HOST
`,
  );
  const digest = createHash("sha256")
    .update(readFileSync(join(release, image)))
    .digest("hex");
  writeFileSync(join(release, "SHA256SUMS.txt"), `${tamper ? "0".repeat(64) : digest}  ${image}\n`);
  if (signature !== "none")
    writeFileSync(
      join(release, "SHA256SUMS.txt.sig"),
      `${(signature === "forged" ? forger : publisher).sign(readFileSync(join(release, "SHA256SUMS.txt")))}\n`,
    );
  executable(
    join(bin, "uname"),
    `#!/bin/sh
case "$1" in -s) echo ${platform} ;; -m) echo ${platform === "Darwin" ? "arm64" : "x86_64"} ;; esac
`,
  );
  if (platform === "Darwin")
    executable(
      join(bin, "ditto"),
      `#!/bin/sh
cd "$4"
sh "$3" --appimage-extract || exit
mkdir -p Gram.app/Contents/MacOS
mv squashfs-root/gram Gram.app/Contents/MacOS/Gram
mv squashfs-root/resources Gram.app/Contents/Resources
rmdir squashfs-root
`,
    );
  // Serves `${RELEASES}/v<version>/<file>` from the folder, as `curl -o <out> <url>` or to stdout.
  executable(
    join(bin, "curl"),
    `#!/bin/sh
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
file="${release}/\${url##*/}"
case "$url" in "${RELEASES}/v${version}/"*) ;; *) exit 22 ;; esac
[ -f "$file" ] || exit 22
if [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi
`,
  );
  for (const tool of ["git", "tailscale", "claude"]) executable(join(bin, tool), "#!/bin/sh\n");
  symlinkSync(OPENSSL, join(bin, "openssl"));
  const run = (text: string, extra: Record<string, string> = {}, shell = "sh") =>
    spawnSync(shell, ["-s", "--", LINK], {
      input: text,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        XDG_DATA_HOME: join(home, ".local", "share"),
        ...extra,
      },
    });
  /** Each run of `gram-host`, in order. */
  const calls = () =>
    readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
  const ran = () => calls()[0];
  return { dir, home, run, ran, calls };
};

describe("the join installer", () => {
  it("is one command, with the link handed over without its quotes", () => {
    expect(installCommand(ORIGIN, `${ORIGIN}/host/join#code=ab'cd`)).toBe(
      `curl -fsSL '${ORIGIN}/host/install' | sh -s -- '${ORIGIN}/host/join#code=abcd'`,
    );
    // Run again on a joined machine it needs no link: the join stands.
    expect(updateCommand(ORIGIN)).toBe(`curl -fsSL '${ORIGIN}/host/install' | sh`);
  });

  it("quotes the installer's URL, so shell characters in the origin are not run", () => {
    const origin = "https://a;id;$(x)'b.ts.net";
    expect(updateCommand(origin)).toBe("curl -fsSL 'https://a;id;$(x)b.ts.net/host/install' | sh");
    expect(installCommand(origin, "l")).toBe(
      "curl -fsSL 'https://a;id;$(x)b.ts.net/host/install' | sh -s -- 'l'",
    );
  });

  for (const shell of ["sh", "dash"].filter((name) => spawnSync(name, ["-c", ":"]).status === 0)) {
    for (const signal of ["HUP", "TERM"]) {
      it(`cleans the temporary extraction after ${signal} under ${shell}`, () => {
        const m = machine("99.14.0");
        try {
          const result = m.run(script("99.14.0"), { SYNTHETIC_UNPACK_SIGNAL: signal }, shell);
          expect(result.status === 0).toBe(false);
          const apps = join(m.home, ".local", "share", "gram-host", "apps");
          expect(readdirSync(apps).filter((name) => name.startsWith(".extract-"))).toEqual([]);
          expect(existsSync(join(apps, "99.14.0"))).toBe(false);
        } finally {
          removeDir(m.dir);
        }
      });
    }
  }

  it("embeds only an https origin and a version", () => {
    expect(() => installScript("https://x.ts.net'; rm -rf ~; '", "1.0.0")).toThrow();
    expect(() => installScript("http://x.ts.net", "1.0.0")).toThrow();
    expect(() => script("1.0.0'; true; '")).toThrow();
    for (const version of ["1.14.0", undefined]) {
      execFileSync("sh", ["-n"], { input: script(version) });
    }
  });

  for (const platform of ["Darwin", "Linux"]) {
    it(`creates the default ${platform} home privately under umask 0022`, () => {
      const m = machine("99.14.0", false, platform);
      try {
        const result = m.run(`umask 0022\n${script("99.14.0")}`);
        expect(result.status, result.stderr).toBe(0);
        const home =
          platform === "Darwin"
            ? join(m.home, "Library", "Application Support", "Gram Host")
            : join(m.home, ".config", "gram-host");
        expect(statSync(home).mode & 0o777).toBe(0o700);
      } finally {
        removeDir(m.dir);
      }
    });

    it(`secures the ${platform} home before creating children, including an override`, () => {
      const m = machine("99.14.0", false, platform);
      try {
        const hostHome = join(m.home, "custom-host");
        mkdirSync(hostHome, { mode: 0o755 });
        const result = m.run(`umask 0022\n${script("99.14.0")}`, {
          GRAM_HOST_HOME: hostHome,
        });
        expect(result.stderr).toContain("Installed");
        expect(result.status).toBe(0);
        expect(statSync(hostHome).mode & 0o777).toBe(0o700);
      } finally {
        removeDir(m.dir);
      }
    });

    it(`refuses a linked ${platform} host home before creating children or joining`, () => {
      const m = machine("99.14.0", false, platform);
      try {
        const elsewhere = join(m.home, "elsewhere");
        mkdirSync(elsewhere);
        const home = join(m.home, "linked-host");
        symlinkSync(elsewhere, home);
        const result = m.run(script("99.14.0"), { GRAM_HOST_HOME: home });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("symbolic link");
        expect(readdirSync(elsewhere)).toEqual([]);
      } finally {
        removeDir(m.dir);
      }
    });

    it(`replaces an incomplete ${platform} cache and publishes only a validated extraction`, () => {
      const m = machine("99.14.0", false, platform);
      try {
        const apps =
          platform === "Darwin"
            ? join(m.home, "Library", "Application Support", "Gram Host", "apps")
            : join(m.home, ".local", "share", "gram-host", "apps");
        const version = join(apps, "99.14.0");
        const binary =
          platform === "Darwin"
            ? join(version, "Gram.app", "Contents", "MacOS", "Gram")
            : join(version, "gram");
        mkdirSync(join(binary, ".."), { recursive: true });
        executable(binary, "#!/bin/sh\nexit 19\n");
        const interrupted = m.run(script("99.14.0"), {
          SYNTHETIC_UNPACK_FAIL: "1",
        });
        expect(interrupted.status).not.toBe(0);
        expect(existsSync(join(version, ".complete"))).toBe(false);
        expect(readdirSync(apps).some((name) => name.startsWith(".extract-"))).toBe(false);
        const result = m.run(script("99.14.0"));
        expect(result.status, result.stderr).toBe(0);
        // On Linux the app runs with Chromium's switches for a machine with no display.
        expect(m.ran()).toEqual({
          args: ["join"],
          stdin: `${LINK}\n`,
          switches: platform === "Darwin" ? [] : LINUX_HOST_SWITCHES,
        });
        expect(existsSync(join(version, ".complete"))).toBe(true);
        // Reuse the completed cache without extracting again.
        expect(m.run(script("99.14.0"), { SYNTHETIC_UNPACK_FAIL: "1" }).status).toBe(0);
        // A completion marker alone never authorizes an app whose entry/resources are broken.
        executable(binary, "#!/bin/sh\nexit 19\n");
        expect(m.run(script("99.14.0")).status).toBe(0);
      } finally {
        removeDir(m.dir);
      }
    });
  }

  it("downloads and checks the release, then joins with the app's own gram-host", () => {
    const { dir, home, run, ran } = machine("1.14.0");
    try {
      const result = run(script("1.14.0"));
      expect(result.stderr).toContain("Installed");
      expect(result.status).toBe(0);
      const app = join(home, ".local", "share", "gram-host", "apps", "1.14.0");
      expect(ran()).toEqual({
        args: ["join"],
        stdin: `${LINK}\n`,
        switches: LINUX_HOST_SWITCHES,
      });
      expect(readFileSync(join(home, ".local", "bin", "gram-host"), "utf8")).toContain(
        `ELECTRON_RUN_AS_NODE=1 exec '${app}/gram' '${app}/resources/app.asar/out/server/gram-host.js' "$@" ${LINUX_HOST_SWITCHES.join(" ")}`,
      );
    } finally {
      removeDir(dir);
    }
  });

  it("on a machine that already joined, moves its service to the new app instead", () => {
    const { dir, home, run, calls } = machine("1.14.0");
    try {
      mkdirSync(join(home, ".config", "gram-host"), { recursive: true });
      const config = join(home, ".config", "gram-host", "host.json");
      writeFileSync(config, JSON.stringify({ origin: "https://other.example-tailnet.ts.net" }));
      const elsewhere = run(script("1.14.0"));
      expect(elsewhere.status).not.toBe(0);
      expect(elsewhere.stderr).toContain("already joined another Gram");
      writeFileSync(config, JSON.stringify({ origin: ORIGIN }));
      const old = join(home, ".local", "share", "gram-host", "apps", "1.13.0");
      mkdirSync(old, { recursive: true });
      const result = run(script("1.14.0"));
      expect(result.status).toBe(0);
      // It moves the service, then says which machine it is, for an install over SSH to check.
      expect(calls()).toEqual([
        {
          args: ["service", "install"],
          stdin: "",
          switches: LINUX_HOST_SWITCHES,
        },
        { args: ["status"], stdin: "", switches: LINUX_HOST_SWITCHES },
      ]);
      expect(existsSync(old)).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  it("as an update, never joins a machine that hasn't joined", () => {
    const { dir, run } = machine("1.14.0");
    try {
      const result = run(script("1.14.0", { update: true }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("nothing to update");
    } finally {
      removeDir(dir);
    }
  });

  it("installs nothing whose checksum doesn't match, or with no release to download", () => {
    const tampered = machine("1.14.0", true);
    try {
      const result = tampered.run(script("1.14.0"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("doesn't match its checksum");
    } finally {
      removeDir(tampered.dir);
    }
    const source = machine("1.14.0");
    try {
      const result = source.run(script(undefined));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("runs from source");
    } finally {
      removeDir(source.dir);
    }
  });
});

const linuxApps = (home: string) => join(home, ".local", "share", "gram-host", "apps");
const macApps = (home: string) => join(home, "Library", "Application Support", "Gram Host", "apps");

describe("the installer's publisher checks", () => {
  for (const [signature, message] of [
    ["forged", "aren't signed by Gram's publisher"],
    ["none", "the release has no checksum signature"],
  ] as const) {
    it(`installs nothing on Linux from a release whose checksums are ${signature === "none" ? "unsigned" : "signed by another key"}`, () => {
      const m = machine("1.14.0", false, "Linux", signature);
      try {
        const result = m.run(script("1.14.0"));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(message);
        expect(existsSync(join(m.dir, "ran.json"))).toBe(false);
        expect(existsSync(join(linuxApps(m.home), "1.14.0"))).toBe(false);
      } finally {
        removeDir(m.dir);
      }
    });
  }

  it("refuses every Linux release while the pinned key is the placeholder", () => {
    const m = machine("1.14.0");
    try {
      const result = m.run(script("1.14.0", {}, { releaseKey: null }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("pins no release signing key");
      expect(existsSync(join(m.dir, "ran.json"))).toBe(false);
    } finally {
      removeDir(m.dir);
    }
  });

  it("on macOS, runs nothing of an app codesign or Gatekeeper refuses, and needs no signed list", () => {
    for (const env of [{ SYNTHETIC_CODESIGN: "3" }, { SYNTHETIC_SPCTL: "3" }]) {
      const m = machine("1.14.0", false, "Darwin", "none");
      try {
        const result = m.run(script("1.14.0"), env);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Signed update refused");
        expect(existsSync(join(m.dir, "ran.json"))).toBe(false);
        expect(existsSync(join(macApps(m.home), "1.14.0"))).toBe(false);
      } finally {
        removeDir(m.dir);
      }
    }
    const m = machine("1.14.0", false, "Darwin", "none");
    try {
      rmSync(join(apple, "asked"), { force: true });
      const result = m.run(script("1.14.0"));
      expect(result.status, result.stderr).toBe(0);
      // The strict deep seal, against the requirement that names the pinned team.
      expect(readFileSync(join(apple, "asked"), "utf8")).toContain(
        '--verify --deep --strict -R =anchor apple generic and identifier "io.github.ant1off.gram"',
      );
      expect(readFileSync(join(apple, "asked"), "utf8")).toContain(
        'certificate leaf[subject.OU] = "FAKETEAM01"',
      );
      // A cached app that no longer passes is never run, and nor is a download that fails too.
      const binary = join(macApps(m.home), "1.14.0", "Gram.app", "Contents", "MacOS", "Gram");
      executable(binary, "#!/bin/sh\nexit 19\n");
      expect(m.run(script("1.14.0"), { SYNTHETIC_CODESIGN: "3" }).status).not.toBe(0);
      expect(existsSync(binary)).toBe(true);
      expect(m.calls()).toHaveLength(1);
    } finally {
      removeDir(m.dir);
    }
  });

  it("on macOS, refuses a download when the build pins no publisher team", () => {
    const m = machine("1.14.0", false, "Darwin", "none");
    try {
      const result = m.run(script("1.14.0", {}, { macTeam: null }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Signed update refused");
    } finally {
      removeDir(m.dir);
    }
  });
});

describe("the installer run over SSH", () => {
  it("carries only this Gram's own join link", () => {
    expect(() => script("1.14.0", { link: "https://evil.example/host/join#code=x" })).toThrow();
    expect(() => script("1.14.0", { link: `${ORIGIN}/host/join#code=a'b` })).toThrow();
    const text = script("1.14.0", { link: LINK });
    expect(text).toContain(`LINK='${LINK}'`);
    execFileSync("sh", ["-n"], { input: text });
  });
});
