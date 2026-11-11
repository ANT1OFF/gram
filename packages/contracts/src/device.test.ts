import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  checkHostedDiscovery,
  DEVICE_COMMAND_MAX_BYTES,
  DEVICE_TIMEOUT_DEFAULT_MS,
  DEVICE_TIMEOUT_MOST_MS,
  DeviceFileEntry,
  DeviceHello,
  deviceApprovalBytes,
  deviceCommandProblem,
  deviceDialBytes,
  deviceTimeout,
  displayCommand,
  HostedWorkspace,
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

  it("draws every code point a person couldn't see, by its Unicode properties", () => {
    // Generated from the properties rather than listed, so a new blank character isn't missed.
    const unseen =
      /[\p{White_Space}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2800\ufffc]/u;
    let checked = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (code === 0x20 || code === 0x0a) continue;
      const character = String.fromCodePoint(code);
      if (!unseen.test(character)) continue;
      // Planes of nothing but unassigned and private use: their edges are enough.
      if (code > 0x30000 && code < 0xe0000 && code % 0x1000 > 2) continue;
      if (code > 0xe1000 && code % 0x1000 > 2 && code % 0x10000 < 0xfffd) continue;
      checked += 1;
      const shown = displayCommand(`a${character}b`);
      const visible = shown.pieces.filter((piece) => piece.kind === "text");
      if (visible.map((piece) => piece.text).join("") !== "ab" || shown.hidden !== (code !== 9))
        expect.fail(`U+${code.toString(16)} isn't drawn as its code`);
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("draws a space no shell splits on as its code", () => {
    for (const code of [
      0xa0, 0x1680, 0x2800, 0x3164, 0x115f, 0x34f, 0xfe00, 0x17b4, 0x180b, 0xe0020,
    ]) {
      const shown = displayCommand(`rm -rf a${String.fromCodePoint(code)}/`);
      expect(shown.hidden, code.toString(16)).toBe(true);
      expect(shown.pieces.some((piece) => piece.kind === "escape")).toBe(true);
    }
  });

  it("draws a tab as its code without calling the command hidden", () => {
    const shown = displayCommand("a\tb");
    expect(shown.hidden).toBe(false);
    expect(shown.pieces).toEqual([
      { kind: "text", text: "a" },
      { kind: "escape", text: "\\t" },
      { kind: "text", text: "b" },
    ]);
    expect(displayCommand("a\r\nb").hidden).toBe(true);
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

describe("what the code review asked to hold", () => {
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

  it("refuses to sign text with a lone surrogate, which would encode like another", () => {
    for (const field of ["\ud800", "r\udfff", "a\ud83d"])
      expect(() => lengthPrefixed(["x", field]), JSON.stringify(field)).toThrow();
    expect(() => lengthPrefixed(["x", "😀"])).not.toThrow();
  });

  it("takes only ids that are printable ASCII", () => {
    const decode = Schema.decodeUnknownOption(HostedWorkspace);
    const workspace = { id: "w-1", name: "n", organisation: "o", role: "member", devices: "on" };
    expect(decode(workspace)._tag).toBe("Some");
    expect(decode({ ...workspace, id: "auth0|ada@example.com" })._tag).toBe("Some");
    for (const id of ["", "a b", "a\nb", "a‮b", "a\0", "r\ud800", "é", "x".repeat(129)])
      expect(decode({ ...workspace, id })._tag, JSON.stringify(id)).toBe("None");
  });

  it("never turns a fraction of a millisecond into no timeout at all", () => {
    for (const asked of [0.5, 0.999, -0.5, 1e-9])
      expect(deviceTimeout(asked), String(asked)).toBe(DEVICE_TIMEOUT_DEFAULT_MS);
    expect(deviceTimeout(1.9)).toBe(1);
  });

  it("refuses a command of nothing but blanks", () => {
    expect(deviceCommandProblem("  \n\t ")).toBe("too-large");
    expect(deviceCommandProblem("x".repeat(DEVICE_COMMAND_MAX_BYTES + 1))).toBe("too-large");
  });

  it("refuses an address spelled so that another reader would find another host", () => {
    for (const changed of [
      { token_endpoint: "https://gram.example.com\\@evil.test/oauth/token" },
      { token_endpoint: "https:\\\\gram.example.com\\oauth\\token" },
      { token_endpoint: "https:gram.example.com/oauth/token" },
      { token_endpoint: " https://gram.example.com/oauth/token" },
      { token_endpoint: "https://gram.exa\tmple.com/oauth/token" },
      { token_endpoint: "https://GRAM.example.com/oauth/token" },
      { devices_endpoint: `${origin}/api/devices/../../x` },
      { devices_endpoint: `${origin}/api/devices?x=1` },
      { devices_endpoint: `${origin}/api/devices#frag` },
      { devices_endpoint: `${origin}/api/devices?` },
      { device_connect: "wss://gram.example.com/device/connect?workspace=other" },
      { client_id: "" },
      { client_id: "gram desktop" },
    ])
      expect(
        checkHostedDiscovery(origin, { ...document, ...changed }),
        JSON.stringify(changed),
      ).toMatchObject({ ok: false });
  });

  it("refuses an origin that isn't written the one way Gram writes it", () => {
    for (const spelled of [`${origin}/`, "HTTPS://gram.example.com", `${origin}:443`])
      expect(
        checkHostedDiscovery(spelled, { ...document, issuer: spelled }),
        spelled,
      ).toMatchObject({ ok: false });
  });

  it("bounds what a request and an answer may carry", () => {
    const hello = {
      protocol: 1,
      deviceId: `d-${"a".repeat(24)}`,
      platform: "linux",
      capabilities: ["read"],
      folders: [],
    };
    const decode = Schema.decodeUnknownOption(DeviceHello);
    expect(decode(hello)._tag).toBe("Some");
    expect(decode({ ...hello, protocol: 0 })._tag).toBe("None");
    const folder = { id: `f-${"a".repeat(16)}`, label: "app" };
    expect(decode({ ...hello, folders: Array.from({ length: 33 }, () => folder) })._tag).toBe(
      "None",
    );
    expect(decode({ ...hello, capabilities: ["read", "exec", "read"] })._tag).toBe("None");
    const entry = Schema.decodeUnknownOption(DeviceFileEntry);
    expect(entry({ name: "a", kind: "file", size: -1 })._tag).toBe("None");
    const exec = DeviceRpcs.requests.get("device.exec");
    expect(exec).toBeDefined();
  });
});
