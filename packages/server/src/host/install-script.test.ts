import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { installCommand, installScript, RELEASES } from "./install-script.ts";

const ORIGIN = "https://studio.example-tailnet.ts.net";
const LINK = `${ORIGIN}/host/join#code=${"a".repeat(64)}`;

const executable = (path: string, text: string) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

/**
 * A synthetic machine with no Gram on it: `curl` serves the release from a folder, and the release's
 * AppImage unpacks to a `gram` that runs its entry with Node and a `gram-host.js` that records
 * how it was run.
 */
const machine = (version: string, tamper = false, platform = "Linux") => {
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
const { readFileSync, writeFileSync } = require("node:fs");
if (process.argv[2] === "--help") process.exit(0);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin: readFileSync(0, "utf8") }));
HOST
`,
  );
  const digest = createHash("sha256")
    .update(readFileSync(join(release, image)))
    .digest("hex");
  writeFileSync(join(release, "SHA256SUMS.txt"), `${tamper ? "0".repeat(64) : digest}  ${image}\n`);
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
  const run = (script: string, extra: Record<string, string> = {}, shell = "sh") =>
    spawnSync(shell, ["-s", "--", LINK], {
      input: script,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        XDG_DATA_HOME: join(home, ".local", "share"),
        ...extra,
      },
    });
  const ran = () => JSON.parse(readFileSync(record, "utf8")) as { args: string[]; stdin: string };
  return { dir, home, run, ran };
};

describe("the join installer", () => {
  it("is one command, with the link handed over without its quotes", () => {
    expect(installCommand(ORIGIN, `${ORIGIN}/host/join#code=ab'cd`)).toBe(
      `curl -fsSL ${ORIGIN}/host/install | sh -s -- '${ORIGIN}/host/join#code=abcd'`,
    );
  });

  for (const shell of ["sh", "dash"].filter((name) => spawnSync(name, ["-c", ":"]).status === 0)) {
    for (const signal of ["HUP", "TERM"]) {
      it(`cleans the temporary extraction after ${signal} under ${shell}`, () => {
        const m = machine("99.14.0");
        try {
          const result = m.run(
            installScript(ORIGIN, "99.14.0"),
            { SYNTHETIC_UNPACK_SIGNAL: signal },
            shell,
          );
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
    expect(() => installScript(ORIGIN, "1.0.0'; true; '")).toThrow();
    for (const version of ["1.14.0", undefined]) {
      execFileSync("sh", ["-n"], { input: installScript(ORIGIN, version) });
    }
  });

  for (const platform of ["Darwin", "Linux"]) {
    it(`creates the default ${platform} home privately under umask 0022`, () => {
      const m = machine("99.14.0", false, platform);
      try {
        const result = m.run(`umask 0022\n${installScript(ORIGIN, "99.14.0")}`);
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
        const result = m.run(`umask 0022\n${installScript(ORIGIN, "99.14.0")}`, {
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
        const result = m.run(installScript(ORIGIN, "99.14.0"), { GRAM_HOST_HOME: home });
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
        const interrupted = m.run(installScript(ORIGIN, "99.14.0"), { SYNTHETIC_UNPACK_FAIL: "1" });
        expect(interrupted.status).not.toBe(0);
        expect(existsSync(join(version, ".complete"))).toBe(false);
        expect(readdirSync(apps).some((name) => name.startsWith(".extract-"))).toBe(false);
        const result = m.run(installScript(ORIGIN, "99.14.0"));
        expect(result.status, result.stderr).toBe(0);
        expect(m.ran()).toEqual({ args: ["join"], stdin: `${LINK}\n` });
        expect(existsSync(join(version, ".complete"))).toBe(true);
        // Reuse the completed cache without extracting again.
        expect(m.run(installScript(ORIGIN, "99.14.0"), { SYNTHETIC_UNPACK_FAIL: "1" }).status).toBe(
          0,
        );
        // A completion marker alone never authorizes an app whose entry/resources are broken.
        executable(binary, "#!/bin/sh\nexit 19\n");
        expect(m.run(installScript(ORIGIN, "99.14.0")).status).toBe(0);
      } finally {
        removeDir(m.dir);
      }
    });
  }

  it("downloads and checks the release, then joins with the app's own gram-host", () => {
    const { dir, home, run, ran } = machine("1.14.0");
    try {
      const result = run(installScript(ORIGIN, "1.14.0"));
      expect(result.stderr).toContain("Installed");
      expect(result.status).toBe(0);
      const app = join(home, ".local", "share", "gram-host", "apps", "1.14.0");
      expect(ran()).toEqual({ args: ["join"], stdin: `${LINK}\n` });
      expect(readFileSync(join(home, ".local", "bin", "gram-host"), "utf8")).toContain(
        `ELECTRON_RUN_AS_NODE=1 exec '${app}/gram' '${app}/resources/app.asar/out/server/gram-host.js' "$@"`,
      );
    } finally {
      removeDir(dir);
    }
  });

  it("on a machine that already joined, moves its service to the new app instead", () => {
    const { dir, home, run, ran } = machine("1.14.0");
    try {
      mkdirSync(join(home, ".config", "gram-host"), { recursive: true });
      const config = join(home, ".config", "gram-host", "host.json");
      writeFileSync(config, JSON.stringify({ origin: "https://other.example-tailnet.ts.net" }));
      const elsewhere = run(installScript(ORIGIN, "1.14.0"));
      expect(elsewhere.status).not.toBe(0);
      expect(elsewhere.stderr).toContain("already joined another Gram");
      writeFileSync(config, JSON.stringify({ origin: ORIGIN }));
      const old = join(home, ".local", "share", "gram-host", "apps", "1.13.0");
      mkdirSync(old, { recursive: true });
      const result = run(installScript(ORIGIN, "1.14.0"));
      expect(result.status).toBe(0);
      expect(ran()).toEqual({ args: ["service", "install"], stdin: "" });
      expect(existsSync(old)).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  it("installs nothing whose checksum doesn't match, or with no release to download", () => {
    const tampered = machine("1.14.0", true);
    try {
      const result = tampered.run(installScript(ORIGIN, "1.14.0"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("doesn't match its checksum");
    } finally {
      removeDir(tampered.dir);
    }
    const source = machine("1.14.0");
    try {
      const result = source.run(installScript(ORIGIN, undefined));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("runs from source");
    } finally {
      removeDir(source.dir);
    }
  });
});

describe("the installer run over SSH", () => {
  it("carries only this Gram's own join link", () => {
    expect(() =>
      installScript(ORIGIN, "1.14.0", "https://evil.example/host/join#code=x"),
    ).toThrow();
    expect(() => installScript(ORIGIN, "1.14.0", `${ORIGIN}/host/join#code=a'b`)).toThrow();
    const script = installScript(ORIGIN, "1.14.0", LINK);
    expect(script).toContain(`LINK='${LINK}'`);
    execFileSync("sh", ["-n"], { input: script });
  });
});
