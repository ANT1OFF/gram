import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  checkHostedDiscovery,
  DEVICE_COMMAND_MAX_BYTES,
  DEVICE_TIMEOUT_DEFAULT_MS,
  DEVICE_TIMEOUT_MOST_MS,
  DeviceHello,
  deviceApprovalBytes,
  deviceCommandProblem,
  deviceDialBytes,
  deviceTimeout,
  displayCommand,
  hostedOrigin,
  lengthPrefixed,
  turnGrantBytes,
} from "./device.ts";
import { DeviceRpcs } from "./rpc/device.ts";
import { HostRpcs } from "./rpc/host.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("lengthPrefixed", () => {
  it("never encodes two different lists alike, however their contents are cut", () => {
    expect(hex(lengthPrefixed(["ab", "c"]))).not.toBe(hex(lengthPrefixed(["a", "bc"])));
    expect(hex(lengthPrefixed(["a\nb"]))).not.toBe(hex(lengthPrefixed(["a", "b"])));
    expect(hex(lengthPrefixed(["", "a"]))).not.toBe(hex(lengthPrefixed(["a", ""])));
  });

  it("counts bytes, not characters", () => {
    expect(hex(lengthPrefixed(["é"]))).toBe("00000002c3a9");
  });
});

describe("what a signature covers", () => {
  const grant = {
    v: 1 as const,
    origin: "https://gram.example.com",
    workspace: "w1",
    thread: "t1",
    nonce: "n".repeat(22),
    issuedAt: 1_000,
    expiresAt: 601_000,
  };

  it("changes with every field of a grant", () => {
    const base = hex(turnGrantBytes(grant));
    for (const changed of [
      { ...grant, origin: "https://gram.example.org" },
      { ...grant, workspace: "w2" },
      { ...grant, thread: "t2" },
      { ...grant, nonce: "m".repeat(22) },
      { ...grant, issuedAt: 1_001 },
      { ...grant, expiresAt: 601_001 },
    ])
      expect(hex(turnGrantBytes(changed))).not.toBe(base);
  });

  it("changes with every field of a dial, the person and the token among them", () => {
    const dial = {
      origin: "https://gram.example.com",
      path: "/device/connect",
      workspace: "w1",
      subject: "ada",
      deviceId: "d-000000000000000000000000",
      tokenHash: "aa",
      time: 5,
      nonce: "n",
    };
    const base = hex(deviceDialBytes(dial));
    for (const key of Object.keys(dial) as Array<keyof typeof dial>)
      expect(
        hex(deviceDialBytes({ ...dial, [key]: key === "time" ? 6 : `${dial[key]}x` })),
        key,
      ).not.toBe(base);
  });

  it("changes with everything an ask showed", () => {
    const approval = {
      origin: "https://gram.example.com",
      workspace: "w1",
      requestId: "r1",
      kind: "exec" as const,
      folder: "/home/ada/code/app",
      target: "/home/ada/code/app",
      command: "make test",
      timeoutMs: 120_000,
    };
    const base = hex(deviceApprovalBytes(approval));
    for (const changed of [
      { ...approval, origin: "https://other.example.com" },
      { ...approval, workspace: "w2" },
      { ...approval, requestId: "r2" },
      { ...approval, kind: "read" as const },
      { ...approval, folder: "/home/ada/code" },
      { ...approval, target: "/home/ada/code/app/vendor" },
      { ...approval, command: "make  test" },
      { ...approval, timeoutMs: 600_000 },
    ])
      expect(hex(deviceApprovalBytes(changed))).not.toBe(base);
  });
});

describe("a command before it is asked", () => {
  it("is refused when empty, over the limit, with a NUL or with a lone surrogate", () => {
    expect(deviceCommandProblem("ls")).toBeUndefined();
    expect(deviceCommandProblem("")).toBe("too-large");
    expect(deviceCommandProblem("ls\0 -la")).toBe("too-large");
    expect(deviceCommandProblem("echo \ud800")).toBe("too-large");
    expect(deviceCommandProblem("a".repeat(DEVICE_COMMAND_MAX_BYTES))).toBeUndefined();
    expect(deviceCommandProblem("a".repeat(DEVICE_COMMAND_MAX_BYTES + 1))).toBe("too-large");
    // The limit is bytes: half as many two-byte characters is already over.
    expect(deviceCommandProblem("é".repeat(DEVICE_COMMAND_MAX_BYTES / 2 + 1))).toBe("too-large");
  });

  it("gets the device's timeout, never more than its most", () => {
    expect(deviceTimeout(undefined)).toBe(DEVICE_TIMEOUT_DEFAULT_MS);
    expect(deviceTimeout(0)).toBe(DEVICE_TIMEOUT_DEFAULT_MS);
    expect(deviceTimeout(Number.NaN)).toBe(DEVICE_TIMEOUT_DEFAULT_MS);
    expect(deviceTimeout(5_000)).toBe(5_000);
    expect(deviceTimeout(60 * 60_000)).toBe(DEVICE_TIMEOUT_MOST_MS);
  });
});

const text = (command: string) =>
  displayCommand(command)
    .pieces.map((piece) => (piece.kind === "newline" ? "⏎" : piece.text))
    .join("");

describe("displayCommand", () => {
  it("leaves a plain command as it is", () => {
    const shown = displayCommand("bin/rails db:migrate:status");
    expect(shown).toEqual({
      pieces: [{ kind: "text", text: "bin/rails db:migrate:status" }],
      hidden: false,
      nonAscii: false,
    });
  });

  it("draws a right-to-left override as its code and flags the command", () => {
    const shown = displayCommand("git log ‮hs | lruc‬");
    expect(shown.hidden).toBe(true);
    expect(text("git log ‮hs | lruc‬")).toBe("git log \\u202ehs | lruc\\u202c");
    expect(shown.pieces.filter((piece) => piece.kind === "escape")).toHaveLength(2);
  });

  it("draws every invisible code point, so none reaches the screen", () => {
    for (const code of [
      0x00,
      0x07,
      0x08,
      0x09,
      0x0d,
      0x1b,
      0x7f,
      0x85,
      0xa0 - 1,
      0xad,
      0x61c,
      0x200b,
      0x200d,
      0x200e,
      0x2028,
      0x2029,
      0x202a,
      0x202e,
      0x2060,
      0x2066,
      0x2069,
      0x3000,
      0xfe0f,
      0xfeff,
      0xe0001,
      0xe0041,
      0xe0100,
    ]) {
      const shown = displayCommand(`a${String.fromCodePoint(code)}b`);
      expect(shown.hidden, code.toString(16)).toBe(true);
      const visible = shown.pieces.filter((piece) => piece.kind === "text");
      expect(visible.map((piece) => piece.text).join(""), code.toString(16)).toBe("ab");
    }
  });

  it("draws a line break as a break, so a second command can't hide after it", () => {
    expect(displayCommand("ls\nrm -rf ~").pieces).toEqual([
      { kind: "text", text: "ls" },
      { kind: "newline" },
      { kind: "text", text: "rm -rf ~" },
    ]);
    // A carriage return would put the cursor back at the start of the line.
    expect(text("echo ok\rrm -rf ~")).toBe("echo ok\\rrm -rf ~");
  });

  it("says when visible characters are outside ASCII, without calling them hidden", () => {
    const shown = displayCommand("curl https://exаmple.com");
    expect(shown.hidden).toBe(false);
    expect(shown.nonAscii).toBe(true);
    expect(displayCommand("echo 'café'").nonAscii).toBe(true);
  });
});

describe("a hosted server's address", () => {
  it("is https, or loopback for tests", () => {
    expect(hostedOrigin("gram.example.com")).toBe("https://gram.example.com");
    expect(hostedOrigin(" https://gram.example.com/ ")).toBe("https://gram.example.com");
    expect(hostedOrigin("https://gram.example.com:8443")).toBe("https://gram.example.com:8443");
    expect(hostedOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(hostedOrigin("http://localhost:4000")).toBe("http://localhost:4000");
  });

  it("is refused over plain http, with a sign-in, a path or a query in it", () => {
    for (const typed of [
      "http://gram.example.com",
      "https://ada:pw@gram.example.com",
      "https://gram.example.com/team",
      "https://gram.example.com/?next=x",
      "https://gram.example.com/#x",
      "ftp://gram.example.com",
      "http://127.0.0.1.example.com",
      "",
      "https://",
    ])
      expect(hostedOrigin(typed), typed).toBeUndefined();
  });

  it("shows a look-alike name as punycode", () => {
    expect(hostedOrigin("https://grаm.example.com")).toBe("https://xn--grm-7cd.example.com");
  });
});

describe("checkHostedDiscovery", () => {
  const origin = "https://gram.example.com";
  const document = {
    version: 1,
    issuer: origin,
    name: "Example Co",
    client_id: "gram-desktop",
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    workspaces_endpoint: `${origin}/api/workspaces`,
    devices_endpoint: `${origin}/api/devices`,
    device_connect: "wss://gram.example.com/device/connect",
  };

  it("accepts a document whose every address is on the server's own origin", () => {
    expect(checkHostedDiscovery(origin, document)).toMatchObject({ ok: true });
  });

  it("accepts plain addresses on loopback only", () => {
    const local = "http://127.0.0.1:4000";
    const plain = Object.fromEntries(
      Object.entries(document).map(([key, value]) => [
        key,
        typeof value === "string"
          ? value.replace("wss://gram.example.com", "ws://127.0.0.1:4000").replace(origin, local)
          : value,
      ]),
    );
    expect(checkHostedDiscovery(local, plain)).toMatchObject({ ok: true });
    expect(checkHostedDiscovery(origin, plain)).toMatchObject({ ok: false });
  });

  it("refuses another issuer, another origin, a downgrade and sign-in in an address", () => {
    for (const changed of [
      { issuer: "https://gram.example.org" },
      { issuer: `${origin}/` },
      { token_endpoint: "https://login.example.net/oauth/token" },
      { authorization_endpoint: "http://gram.example.com/oauth/authorize" },
      { workspaces_endpoint: "https://gram.example.com.evil.test/api/workspaces" },
      { devices_endpoint: "https://x:y@gram.example.com/api/devices" },
      { device_connect: "ws://gram.example.com/device/connect" },
      { device_connect: "wss://gram.example.com:444/device/connect" },
      { device_connect: "https://gram.example.com/device/connect" },
      { version: 2 },
      { client_id: undefined },
    ])
      expect(
        checkHostedDiscovery(origin, { ...document, ...changed }),
        JSON.stringify(changed),
      ).toMatchObject({ ok: false });
    expect(checkHostedDiscovery(origin, "nope")).toMatchObject({ ok: false });
    expect(checkHostedDiscovery("http://gram.example.com", document)).toMatchObject({ ok: false });
  });
});

describe("the device's service", () => {
  it("is exactly these calls, and none of a host's", () => {
    expect([...DeviceRpcs.requests.keys()].toSorted()).toEqual([
      "device.cancel",
      "device.exec",
      "device.files.list",
      "device.files.read",
      "device.hello",
      "device.token",
    ]);
    for (const tag of HostRpcs.requests.keys())
      expect(DeviceRpcs.requests.has(tag), tag).toBe(false);
  });

  it("has a hello with no room for a path, a machine name or a release", () => {
    const hello = {
      protocol: 1,
      deviceId: "d-0123456789abcdef01234567",
      platform: "darwin",
      capabilities: ["read", "exec"],
      folders: [{ id: "f-0123456789abcdef", label: "app" }],
    };
    expect(Object.keys(DeviceHello.fields).toSorted()).toEqual([
      "capabilities",
      "deviceId",
      "folders",
      "platform",
      "protocol",
    ]);
    expect(Schema.decodeUnknownSync(DeviceHello)(hello)).toEqual(hello);
    expect(() =>
      Schema.decodeUnknownSync(DeviceHello)({
        ...hello,
        folders: [{ id: "/Users/ada/code/app", label: "app" }],
      }),
    ).toThrow();
  });
});
