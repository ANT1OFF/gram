import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * A Linux machine with no Gram on it: `curl` serves the release from a folder, and the release's
 * AppImage unpacks to a `gram` that runs its entry with Node and a `gram-host.js` that records
 * how it was run.
 */
const machine = (version: string, tamper = false) => {
  const dir = tempDir();
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const release = join(dir, "release");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  mkdirSync(release);
  const record = join(dir, "ran.json");
  const image = `gram_${version}_x86_64.AppImage`;
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
cat >squashfs-root/resources/app.asar/out/server/gram-host.js <<'HOST'
const { readFileSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin: readFileSync(0, "utf8") }));
HOST
`,
  );
  const digest = createHash("sha256")
    .update(readFileSync(join(release, image)))
    .digest("hex");
  writeFileSync(join(release, "SHA256SUMS.txt"), `${tamper ? "0".repeat(64) : digest}  ${image}\n`);
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
  const run = (script: string) =>
    spawnSync("sh", ["-s", "--", LINK], {
      input: script,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        XDG_DATA_HOME: join(home, ".local", "share"),
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

  it("embeds only an https origin and a version", () => {
    expect(() => installScript("https://x.ts.net'; rm -rf ~; '", "1.0.0")).toThrow();
    expect(() => installScript("http://x.ts.net", "1.0.0")).toThrow();
    expect(() => installScript(ORIGIN, "1.0.0'; true; '")).toThrow();
    for (const version of ["1.14.0", undefined]) {
      execFileSync("sh", ["-n"], { input: installScript(ORIGIN, version) });
    }
  });

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "downloads and checks the release, then joins with the app's own gram-host",
    () => {
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
    },
  );

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "on a machine that already joined, moves its service to the new app instead",
    () => {
      const { dir, home, run, ran } = machine("1.14.0");
      try {
        mkdirSync(join(home, ".config", "gram-host"), { recursive: true });
        writeFileSync(join(home, ".config", "gram-host", "host.json"), "{}");
        const old = join(home, ".local", "share", "gram-host", "apps", "1.13.0");
        mkdirSync(old, { recursive: true });
        const result = run(installScript(ORIGIN, "1.14.0"));
        expect(result.status).toBe(0);
        expect(ran()).toEqual({ args: ["service", "install"], stdin: "" });
        expect(existsSync(old)).toBe(false);
      } finally {
        removeDir(dir);
      }
    },
  );

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "installs nothing whose checksum doesn't match, or with no release to download",
    () => {
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
    },
  );
});
