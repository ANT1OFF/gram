import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultName, leave, parseJoinLink } from "./cli.ts";
import { readHostConfig, writeJoined } from "./host-config.ts";
import { generateHostKey, hostIdOf } from "./machine-keys.ts";
import {
  launchdPlist,
  type Run,
  type ServicePlatform,
  type ServiceRunner,
  systemdUnit,
  uninstallService,
} from "./service.ts";

const command = {
  program: ["/opt/node 26/bin/node", "/srv/gram/main.ts", "run"],
  env: { GRAM_HOST_HOME: "/home/a/.config/gram-host", PATH: "/usr/bin:/bin" },
  home: "/home/a/.config/gram-host",
};

describe("the host's background service", () => {
  it("runs the host from launchd at login, kept alive, logging to its folder", () => {
    const plist = launchdPlist({ ...command, program: [...command.program, "<&>"] });
    expect(plist).toContain("<string>/opt/node 26/bin/node</string>");
    expect(plist).toContain("<string>&lt;&amp;&gt;</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/home/a/.config/gram-host/host.log</string>");
  });

  it("runs the host from a systemd user unit, its words quoted and escaped", () => {
    const unit = systemdUnit({
      ...command,
      env: { ...command.env, ODD: 'a"b%c$d\\e' },
    });
    expect(unit).toContain('ExecStart="/opt/node 26/bin/node" "/srv/gram/main.ts" "run"');
    expect(unit).toContain('Environment="ODD=a\\"b%%c$d\\\\e"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdUnit({ ...command, program: ["/srv/$HOME/node"] })).toContain(
      'ExecStart="/srv/$$HOME/node"',
    );
    expect(() => systemdUnit({ ...command, program: ["/a\nb"] })).toThrow();
  });
});

describe("gram-host join", () => {
  it("takes only a join link to a tailnet address", () => {
    const code = "a".repeat(64);
    expect(parseJoinLink(`https://main.example-tailnet.ts.net/host/join#code=${code}`)).toEqual({
      origin: "https://main.example-tailnet.ts.net",
      code,
    });
    expect(
      parseJoinLink(`http://main.example-tailnet.ts.net/host/join#code=${code}`),
    ).toHaveProperty("error");
    expect(parseJoinLink(`https://example.com/host/join#code=${code}`)).toHaveProperty("error");
    expect(parseJoinLink("https://main.example-tailnet.ts.net/host/join#code=12")).toHaveProperty(
      "error",
    );
    expect(parseJoinLink("nonsense")).toHaveProperty("error");
  });

  it("names the machine after its host name", () => {
    expect(defaultName("Studio.local")).toBe("Studio");
    expect(defaultName("build/box:1")).toBe("build-box-1");
    expect(defaultName("")).toBe("machine");
  });
});

/** A service manager that answers each command by its verb, and records what it was asked. */
const manager = (answers: Readonly<Record<string, Run>>) => {
  const asked: string[] = [];
  const runner: ServiceRunner = (file, args) =>
    Effect.sync(() => {
      const verb = args.find((arg) => !arg.startsWith("-"))!;
      asked.push(`${file} ${verb}`);
      return answers[verb] ?? { code: 0, output: "" };
    });
  return { runner, asked };
};

// Joined-machines audit K1: a failed `launchctl bootout` or `systemctl --user disable --now` was
// ignored, the service file removed and the join forgotten while the host could still be running.
describe("removing the host's background service", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gram-host-service-"));
    file = join(dir, "gram-host.service");
    writeFileSync(file, "synthetic unit\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const uninstall = (platform: ServicePlatform, answers: Readonly<Record<string, Run>>) =>
    Effect.runSync(Effect.exit(uninstallService(platform, manager(answers).runner, file)));

  it("keeps the file and fails when a stop failed and the service is still loaded or running", () => {
    const mac = uninstall("darwin", {
      bootout: { code: 5, output: "Boot-out failed: 5: Input/output error" },
      print: { code: 0, output: "state = running" },
    });
    expect(Exit.isFailure(mac)).toBe(true);
    expect(String(mac)).toMatch(/may still be running/);
    expect(existsSync(file)).toBe(true);
    const linux = uninstall("linux", {
      disable: { code: 1, output: "Failed to stop gram-host.service: Transport endpoint" },
      "is-active": { code: 0, output: "active" },
    });
    expect(Exit.isFailure(linux)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("keeps the file and fails when a stop failed and the manager can't say whether it stopped", () => {
    const bus = { code: 1, output: "Failed to connect to bus: No medium found" };
    expect(Exit.isFailure(uninstall("linux", { disable: bus, "is-active": bus }))).toBe(true);
    expect(existsSync(file)).toBe(true);
    // Review of #324: a missing file isn't proof it never ran, as a service stays loaded after
    // its file goes (as the old uninstall could leave it).
    rmSync(file);
    expect(Exit.isFailure(uninstall("linux", { disable: bus, "is-active": bus }))).toBe(true);
    const unknown = { code: 1, output: "Bad request." };
    expect(Exit.isFailure(uninstall("darwin", { bootout: unknown, print: unknown }))).toBe(true);
  });

  it("takes a service that isn't installed or running as removed", () => {
    expect(
      Exit.isSuccess(
        uninstall("darwin", {
          bootout: { code: 3, output: "Boot-out failed: 3: No such process" },
          print: { code: 113, output: 'Could not find service "io.github.ant1off.gram.host"' },
        }),
      ),
    ).toBe(true);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "synthetic unit\n");
    const { runner, asked } = manager({
      disable: {
        code: 1,
        output: "Failed to disable unit: Unit file gram-host.service does not exist.",
      },
      "is-active": { code: 3, output: "inactive" },
    });
    expect(
      Exit.isSuccess(Effect.runSync(Effect.exit(uninstallService("linux", runner, file)))),
    ).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(asked).toEqual(["systemctl disable", "systemctl is-active", "systemctl daemon-reload"]);
  });

  it("fails a stop that reported success while the service is still running", () => {
    const exit = uninstall("darwin", { print: { code: 0, output: "state = running" } });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});

describe("gram-host leave", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gram-host-leave-"));
    const key = generateHostKey();
    writeJoined(
      home,
      {
        version: 1,
        origin: "https://main.example-tailnet.ts.net",
        hostId: hostIdOf(key.publicKey),
        name: "box",
      },
      key.privateKeyPem,
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the join and says the host may still be running when its service didn't stop", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    Effect.runSync(
      leave(
        home,
        Effect.fail(new Error("The background service didn't stop; it may still be running.")),
      ),
    );
    expect(readHostConfig(home)).toBeDefined();
    expect(process.exitCode).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /may still be running\. This machine is still joined/,
    );
    expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringMatching(/^Left/));
  });

  it("forgets the join once its service stopped", () => {
    Effect.runSync(leave(home, Effect.void));
    expect(readHostConfig(home)).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });
});
