// A personal device: a person's own machine, lent to a hosted workspace while they work in the
// desktop app. The design, its trust model and its threat model are in
// `docs/design/personal-device.md`. Everything here is data: the shapes both ends agree on, the
// bytes a signature or an approval covers, and how a command is drawn before anyone allows it.

import * as Schema from "effect/Schema";

/**
 * The device protocol's version, in the hello. Its own number, not the host protocol's: a device
 * serves `DeviceRpcs` and nothing of `HostRpcs`.
 */
export const DEVICE_PROTOCOL_VERSION = 1;

/** A command is at most this many UTF-8 bytes. */
export const DEVICE_COMMAND_MAX_BYTES = 8 * 1024;
/** A read sends at most this much of a file. */
export const DEVICE_READ_MAX_BYTES = 1024 * 1024;
/** A listing names at most this many entries. */
export const DEVICE_LIST_MAX_ENTRIES = 500;
/** A command's output is at most this much, the end kept. */
export const DEVICE_OUTPUT_MAX_BYTES = 256 * 1024;
/** A device lends at most this many folders to a workspace. */
export const DEVICE_FOLDERS_MOST = 32;
/** One `output` event carries at most this many characters. */
export const DEVICE_OUTPUT_EVENT_MAX = 64 * 1024;
/** A command runs this long unless the request asks for less, or for more up to the most. */
export const DEVICE_TIMEOUT_DEFAULT_MS = 2 * 60_000;
export const DEVICE_TIMEOUT_MOST_MS = 10 * 60_000;
/** An ask nobody answers is refused after this long. */
export const DEVICE_ASK_WAIT_MS = 5 * 60_000;
/** How long after the person writes to a thread from this machine that thread may ask. */
export const DEVICE_GRANT_TTL_MS = 10 * 60_000;
/** How far a signed time may be from the verifier's clock. */
export const DEVICE_CLOCK_SKEW_MS = 2 * 60_000;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
/** An id: printable ASCII without spaces, so two ids never differ only in what can't be seen. */
const Id = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));

/** A device's id, derived from its public key so no other key can claim it. */
export const DeviceId = Schema.String.check(Schema.isPattern(/^d-[a-f0-9]{24}$/)).pipe(
  Schema.brand("DeviceId"),
);
export type DeviceId = typeof DeviceId.Type;

/**
 * Why a device didn't do what it was asked. A fixed set, so a thread can say what happened without
 * the device describing its disk.
 */
export const DeviceRefusalReason = Schema.Literals([
  /** The person chose Don't run or Don't read. */
  "not-allowed-by-person",
  /** Nobody answered the ask in time. */
  "not-answered",
  /** No turn grant, or one that is forged, expired, withdrawn or for another thread. */
  "no-grant",
  /** The screen locked, the person stepped away or lending stopped. */
  "away",
  /** The folder isn't lent, or the path leaves it. */
  "outside-folders",
  /** The path names a credential or lies in `.git`. */
  "credential-path",
  /** Not a regular file with one link: a folder, a FIFO, a device, a hard-linked file. */
  "not-a-file",
  /** Too many asks waiting, or too many in the last minutes. */
  "too-many-requests",
  /** Lending to this server is paused until the person lifts it. */
  "paused",
  /** This workspace's lending allows reading only. */
  "read-only",
  /** The command or the file is over its limit. */
  "too-large",
  /** The request names an acting person who isn't the one signed in here. */
  "not-for-this-person",
  /** A request id seen before, with a different payload. */
  "changed-request",
]);
export type DeviceRefusalReason = typeof DeviceRefusalReason.Type;

/**
 * What the device knows without believing the server: its own person wrote to this thread from
 * its own app at `issuedAt`. Minted and signed by the device as the message leaves, and required
 * on every request of the turn that message started.
 */
export const TurnGrant = Schema.Struct({
  v: Schema.Literal(1),
  /** The hosted server's origin, as the person signed in to it. */
  origin: Text(512),
  workspace: Id,
  thread: Id,
  /** Random, so two grants for one thread at one instant differ. */
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/)),
  issuedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TurnGrant = typeof TurnGrant.Type;

/** A grant with the device key's signature over `turnGrantBytes`, base64url. */
export const SignedTurnGrant = Schema.Struct({
  grant: TurnGrant,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type SignedTurnGrant = typeof SignedTurnGrant.Type;

/**
 * Fields as one byte string, each prefixed with its length as four big-endian bytes, so no choice
 * of field contents makes two different lists encode alike. A field with a lone surrogate isn't
 * text and has no bytes of its own, so it is refused rather than encoded as something else.
 */
export const lengthPrefixed = (fields: ReadonlyArray<string>): Uint8Array => {
  if (fields.some((field) => typeof field !== "string" || !field.isWellFormed()))
    throw new Error("A signed field isn't well-formed text");
  const encoder = new TextEncoder();
  const parts = fields.map((field) => encoder.encode(field));
  const bytes = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const part of parts) {
    view.setUint32(at, part.length);
    bytes.set(part, at + 4);
    at += 4 + part.length;
  }
  return bytes;
};

/** The bytes a turn grant's signature covers. */
export const turnGrantBytes = (grant: TurnGrant): Uint8Array =>
  lengthPrefixed([
    "gram-device-grant-v1",
    grant.origin,
    grant.workspace,
    grant.thread,
    grant.nonce,
    String(grant.issuedAt),
    String(grant.expiresAt),
  ]);

/** What a dial's signature names, so its headers work with no other token, person or workspace. */
export interface DeviceDial {
  readonly origin: string;
  readonly path: string;
  readonly workspace: string;
  /** The signed-in person's subject id, as the server issued it. */
  readonly subject: string;
  readonly deviceId: string;
  /** SHA-256 of the access token the dial carries, hex. */
  readonly tokenHash: string;
  readonly time: number;
  readonly nonce: string;
}

/** The bytes a dial's signature covers. */
export const deviceDialBytes = (dial: DeviceDial): Uint8Array =>
  lengthPrefixed([
    "gram-device-v1",
    dial.origin,
    dial.path,
    dial.workspace,
    dial.subject,
    dial.deviceId,
    dial.tokenHash,
    String(dial.time),
    dial.nonce,
  ]);

/** What a device signs to register its key: a challenge the server just gave this person. */
export interface DeviceRegistration {
  readonly origin: string;
  readonly subject: string;
  /** The raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  readonly challenge: string;
}

/** The bytes a registration's signature covers. */
export const deviceRegistrationBytes = (registration: DeviceRegistration): Uint8Array =>
  lengthPrefixed([
    "gram-device-register-v1",
    registration.origin,
    registration.subject,
    registration.publicKey,
    registration.challenge,
  ]);

/** The headers a device proves itself with when it dials. */
export const DEVICE_ID_HEADER = "x-gram-device-id";
export const DEVICE_TIME_HEADER = "x-gram-device-time";
export const DEVICE_NONCE_HEADER = "x-gram-device-nonce";
export const DEVICE_SIGNATURE_HEADER = "x-gram-device-signature";

/** What an ask showed, which is what the person's answer is bound to. */
export interface DeviceApproval {
  readonly origin: string;
  readonly workspace: string;
  readonly requestId: string;
  readonly kind: "exec" | "read" | "list";
  /** The lent folder's real path. */
  readonly folder: string;
  /** The real working folder of a command, or the real path of the file or folder read. */
  readonly target: string;
  /** The command, exactly as it will run; empty for a read or a listing. */
  readonly command: string;
  /** The command's timeout; zero for a read or a listing. */
  readonly timeoutMs: number;
}

/** The bytes an approval's hash covers. */
export const deviceApprovalBytes = (approval: DeviceApproval): Uint8Array =>
  lengthPrefixed([
    "gram-device-approval-v1",
    approval.origin,
    approval.workspace,
    approval.requestId,
    approval.kind,
    approval.folder,
    approval.target,
    approval.command,
    String(approval.timeoutMs),
  ]);

/** A lent folder as the server sees it: an opaque id and the label the person chose. */
export const DeviceFolder = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^f-[a-f0-9]{16}$/)),
  /** The folder's own name unless the person chose another; never its path. */
  label: Text(128),
});
export type DeviceFolder = typeof DeviceFolder.Type;

/** What the device can do for this workspace. `exec` is left out when lending is read only. */
export const DeviceCapability = Schema.Literals(["read", "exec"]);
export type DeviceCapability = typeof DeviceCapability.Type;

/**
 * `device.hello`. It carries nothing about the disk beyond the chosen labels, and neither the
 * machine's name nor the app's release.
 */
export const DeviceHello = Schema.Struct({
  protocol: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  deviceId: DeviceId,
  platform: Schema.Literals(["darwin", "linux", "win32"]),
  capabilities: Schema.Array(DeviceCapability).check(Schema.isMaxLength(2)),
  folders: Schema.Array(DeviceFolder).check(Schema.isMaxLength(DEVICE_FOLDERS_MOST)),
});
export type DeviceHello = typeof DeviceHello.Type;

/**
 * What every request says about itself. `thread.title`, `actor.name` and `othersWrote` are the
 * server's word: shown, labelled as such, and deciding nothing. `thread.id` is checked against the
 * grant and `actor.id` against the person signed in.
 */
export const DeviceRequestBy = {
  requestId: Id,
  grant: SignedTurnGrant,
  thread: Schema.Struct({ id: Id, title: Text(256) }),
  actor: Schema.Struct({ id: Id, name: Text(128) }),
  /** Others have written in the thread since the owner's previous message. */
  othersWrote: Schema.optionalKey(Schema.Boolean),
  folderId: DeviceFolder.fields.id,
};

/** A path inside a lent folder: relative, with `/` between names. Checked again on the device. */
export const DeviceRelativePath = Text(4096);

export const DeviceRefused = Schema.Struct({
  kind: Schema.Literal("refused"),
  why: DeviceRefusalReason,
});
export type DeviceRefused = typeof DeviceRefused.Type;

/** `device.exec`, as it goes: asked, then refused, or started, its output and how it ended. */
export const DeviceExecEvent = Schema.Union([
  /** The ask is on screen, or waiting behind another. */
  Schema.Struct({ kind: Schema.Literal("asked") }),
  DeviceRefused,
  Schema.Struct({ kind: Schema.Literal("started") }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Text(DEVICE_OUTPUT_EVENT_MAX),
  }),
  Schema.Struct({
    kind: Schema.Literal("exit"),
    code: Schema.optionalKey(Schema.Int),
    signal: Schema.optionalKey(Text(32)),
    /** The output was over its limit and only its end was sent. */
    truncated: Schema.Boolean,
    /** The command ran past its timeout and was stopped. */
    timedOut: Schema.Boolean,
  }),
]);
export type DeviceExecEvent = typeof DeviceExecEvent.Type;

export const DeviceFileEntry = Schema.Struct({
  name: Text(1024),
  kind: Schema.Literals(["file", "folder", "other"]),
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type DeviceFileEntry = typeof DeviceFileEntry.Type;

export const DeviceListResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("listed"),
    entries: Schema.Array(DeviceFileEntry).check(Schema.isMaxLength(DEVICE_LIST_MAX_ENTRIES)),
    /** There were more entries than the limit. */
    truncated: Schema.Boolean,
  }),
  DeviceRefused,
]);
export type DeviceListResult = typeof DeviceListResult.Type;

export const DeviceReadResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("read"),
    /** The file's bytes, base64. */
    data: Text(Math.ceil(DEVICE_READ_MAX_BYTES / 3) * 4),
    /** The file is longer than what was sent. */
    truncated: Schema.Boolean,
  }),
  DeviceRefused,
]);
export type DeviceReadResult = typeof DeviceReadResult.Type;

/** Why a command can't be asked for at all, before anything else is looked at. */
export const deviceCommandProblem = (command: string): "too-large" | undefined => {
  // UTF-8 is never shorter than UTF-16, so a command this long is over without being encoded.
  if (command.length > DEVICE_COMMAND_MAX_BYTES) return "too-large";
  if (command.trim().length === 0 || command.includes("\0")) return "too-large";
  // A lone surrogate isn't text, and would be re-encoded as something else on the way to a shell.
  if (!command.isWellFormed()) return "too-large";
  return new TextEncoder().encode(command).length > DEVICE_COMMAND_MAX_BYTES
    ? "too-large"
    : undefined;
};

/** A command's timeout within the device's own bounds, whatever the request asked for. */
export const deviceTimeout = (asked: number | undefined): number => {
  // Floored before it is judged: half a millisecond must not become zero, which means no limit.
  const whole = asked === undefined || !Number.isFinite(asked) ? 0 : Math.floor(asked);
  return whole <= 0 ? DEVICE_TIMEOUT_DEFAULT_MS : Math.min(whole, DEVICE_TIMEOUT_MOST_MS);
};

/** A piece of a command as the ask draws it. */
export type CommandPiece =
  | { readonly kind: "text"; readonly text: string }
  /** A code point nobody could see, drawn as its code. */
  | { readonly kind: "escape"; readonly text: string }
  | { readonly kind: "newline" };

export interface CommandDisplay {
  readonly pieces: ReadonlyArray<CommandPiece>;
  /**
   * It has control, bidirectional, zero-width, blank or other invisible code points. A tab is
   * drawn as its code but doesn't count: scripts are full of them.
   */
  readonly hidden: boolean;
  /** It has visible characters outside ASCII, which may be look-alikes. */
  readonly nonAscii: boolean;
}

/**
 * Code points a person can't see or can't tell from a space, by their Unicode properties: every
 * kind of white space but the space itself, controls, format characters, private use, unassigned
 * and noncharacters, lone surrogates, and everything a renderer is told to ignore. The three named
 * ones draw as blanks or as nothing though their properties say otherwise.
 */
const INVISIBLE =
  /[\p{White_Space}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2800\ufffc\u{1d159}]/u;

const invisible = (code: number): boolean =>
  code !== 0x20 && INVISIBLE.test(String.fromCodePoint(code));

const escapeOf = (code: number): string =>
  code === 0x09
    ? "\\t"
    : code === 0x0d
      ? "\\r"
      : code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : `\\u{${code.toString(16)}}`;

/**
 * A command as the ask shows it: every code point a person couldn't see drawn as its code, line
 * breaks as breaks, and nothing else changed. What runs is the command itself, never this. The
 * same drawing is for any text a server worded that a main-owned window shows: a thread's title,
 * a person's name, a reason, a server's or a workspace's name. A window must draw an escape piece
 * unlike text, since `\\u202e` typed out and the character itself give the same letters.
 */
export const displayCommand = (command: string): CommandDisplay => {
  const pieces: Array<CommandPiece> = [];
  let text = "";
  let hidden = false;
  let nonAscii = false;
  const flush = () => {
    if (text !== "") pieces.push({ kind: "text", text });
    text = "";
  };
  for (let index = 0; index < command.length;) {
    const code = command.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    if (code === 0x0a) {
      flush();
      pieces.push({ kind: "newline" });
    } else if (invisible(code)) {
      flush();
      if (code !== 0x09) hidden = true;
      pieces.push({ kind: "escape", text: escapeOf(code) });
    } else {
      if (code > 0x7e) nonAscii = true;
      text += String.fromCodePoint(code);
    }
  }
  flush();
  return { pieces, hidden, nonAscii };
};

/** `https://<server>/.well-known/gram-hosted`: where a hosted server's calls are. */
export const HOSTED_DISCOVERY_PATH = "/.well-known/gram-hosted";

const Address = Text(2048);

export const HostedDiscovery = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Address,
  /** What the server calls itself. Shown as its own word. */
  name: Text(128),
  client_id: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/)),
  authorization_endpoint: Address,
  token_endpoint: Address,
  workspaces_endpoint: Address,
  devices_endpoint: Address,
  device_connect: Address,
});
export type HostedDiscovery = typeof HostedDiscovery.Type;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin of the address a person typed for a hosted server, or undefined when it isn't one
 * Gram will use: `https:` only, except loopback for tests, with no sign-in, path, query or
 * fragment in it. The host is in its ASCII form, so a look-alike name shows as punycode.
 */
export const hostedOrigin = (typed: string): string | undefined => {
  const text = typed.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== ""))
    return undefined;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url.origin : undefined;
};

export type HostedDiscoveryChecked =
  | { readonly ok: true; readonly discovery: HostedDiscovery }
  | { readonly ok: false; readonly why: string };

/**
 * A discovery document a server at `origin` answered with, or why it is refused: its issuer must
 * be that origin and every address must be on it, `https:` for calls and `wss:` for the dial
 * (`http:` and `ws:` on loopback).
 */
export const checkHostedDiscovery = (origin: string, document: unknown): HostedDiscoveryChecked => {
  const decoded = Schema.decodeUnknownOption(HostedDiscovery)(document);
  if (decoded._tag === "None")
    return { ok: false, why: "The server's answer isn't one Gram reads." };
  const discovery = decoded.value;
  if (hostedOrigin(origin) !== origin)
    return { ok: false, why: "The address isn't one Gram uses." };
  if (discovery.issuer !== origin)
    return { ok: false, why: "The server names another address as its own." };
  const secure = origin.startsWith("https:");
  const on = (address: string, protocol: string): boolean => {
    try {
      const url = new URL(address);
      return (
        url.href === address &&
        url.search === "" &&
        url.hash === "" &&
        !address.includes("?") &&
        !address.includes("#") &&
        url.protocol === protocol &&
        url.host === new URL(origin).host &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  };
  const calls = [
    discovery.authorization_endpoint,
    discovery.token_endpoint,
    discovery.workspaces_endpoint,
    discovery.devices_endpoint,
  ];
  if (!calls.every((address) => on(address, secure ? "https:" : "http:")))
    return { ok: false, why: "The server sends Gram to another address." };
  if (!on(discovery.device_connect, secure ? "wss:" : "ws:"))
    return { ok: false, why: "The server sends Gram to another address." };
  return { ok: true, discovery };
};

/** An organisation's policy for lending to a workspace, as the server will enforce it. */
export const HostedDevicePolicy = Schema.Literals(["off", "read", "on"]);
export type HostedDevicePolicy = typeof HostedDevicePolicy.Type;

/** A workspace on a hosted server, as its `workspaces_endpoint` lists it. All the server's word. */
export const HostedWorkspace = Schema.Struct({
  id: Id,
  name: Text(128),
  organisation: Text(128),
  role: Text(64),
  devices: HostedDevicePolicy,
});
export type HostedWorkspace = typeof HostedWorkspace.Type;

/** The workspaces endpoint's answer. */
export const HostedWorkspaces = Schema.Array(HostedWorkspace).check(Schema.isMaxLength(500));

/** `POST devices_endpoint/challenge`'s answer: something new to sign, for this person alone. */
export const HostedDeviceChallenge = Schema.Struct({
  challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22,128}$/)),
});

/** `POST devices_endpoint`'s answer: the id the server derived from the key. */
export const HostedDeviceRegistered = Schema.Struct({ deviceId: DeviceId });

/**
 * A token endpoint's answer, as Gram reads it: OAuth's fields, and `sub`, the person's subject
 * id, which Gram's protocol adds so a device knows whom it signs for.
 */
export const HostedTokenAnswer = Schema.Struct({
  access_token: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,4096}$/)),
  token_type: Schema.String.check(Schema.isMaxLength(32)),
  expires_in: Schema.Number.check(Schema.isFinite()),
  refresh_token: Schema.optional(Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,4096}$/))),
  scope: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  sub: Id,
});
export type HostedTokenAnswer = typeof HostedTokenAnswer.Type;
