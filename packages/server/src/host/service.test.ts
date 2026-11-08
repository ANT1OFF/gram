import { describe, expect, it } from "vitest";
import { defaultName, parseJoinLink } from "./cli.ts";
import { launchdPlist, systemdUnit } from "./service.ts";

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
