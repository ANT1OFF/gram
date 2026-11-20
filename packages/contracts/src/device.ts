// A personal device: a person's own machine, lent to a hosted workspace while they work in the
// desktop app. The design, its trust model and its threat model are in
// `docs/design/personal-device.md`. Everything here is data: the shapes both ends agree on, the
// bytes a signature or an approval covers, and how a command is drawn before anyone allows it.

import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

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
  /**
   * Where a thread moved from this machine is brought in (`POST`, `HostedThreadImport`). Absent on
   * a server that takes none.
   */
  thread_import_endpoint: Schema.optionalKey(Address),
  /**
   * Where a thread that moved there is asked for, to bring it back to this machine (`POST`,
   * `HostedThreadExport`), and where its copy there is settled once it is here (`POST`,
   * `HostedThreadSettle`). Both or neither; absent on a server that gives none back.
   */
  thread_export_endpoint: Schema.optionalKey(Address),
  thread_settle_endpoint: Schema.optionalKey(Address),
  /**
   * Where work is sent from this machine to run there, as a new thread of a workspace (`POST`,
   * `HostedThreadStart`), and where what was sent is followed (`HostedThreadWait`), answered
   * (`HostedThreadMessage`) and stopped (`HostedThreadStop`). All four or none; absent on a server
   * that runs no work sent to it.
   */
  thread_start_endpoint: Schema.optionalKey(Address),
  thread_wait_endpoint: Schema.optionalKey(Address),
  thread_message_endpoint: Schema.optionalKey(Address),
  thread_stop_endpoint: Schema.optionalKey(Address),
  /**
   * Where this machine asks, before it sends work, whether a thread there could clone each
   * repository and push its branch (`POST`, `HostedRepositoryReach`). Absent: it isn't asked.
   */
  thread_check_endpoint: Schema.optionalKey(Address),
  /**
   * Where this machine reads (`machine_status_endpoint`) and starts (`machine_start_endpoint`) the
   * person's own machine in a workspace there, for work sent with none running (`POST`,
   * `{workspaceId}`, answered `HostedMachine`). Both or neither; absent on a server that starts no
   * machine from here.
   */
  machine_status_endpoint: Schema.optionalKey(Address),
  machine_start_endpoint: Schema.optionalKey(Address),
  /**
   * Where model calls are sent on the person's behalf, by a CLI on this machine that this machine
   * forwards with the sign-in: a provider's own path follows it (`/v1/messages`). Absent on a
   * server that takes none.
   */
  models_endpoint: Schema.optionalKey(Address),
  /**
   * Where this machine's orchestrators ask for a machine of a worker's own, with the person's
   * sign-in (`POST <it>/choices`, `/start`, `/status`, `/release`, `/stop`), and where this machine
   * carries such a machine's connection to its own Gram (`worker_machine_connect`, a WebSocket).
   * Both or neither; absent on a server that starts none for a desktop.
   */
  worker_machines_endpoint: Schema.optionalKey(Address),
  worker_machine_connect: Schema.optionalKey(Address),
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
    ...(discovery.thread_import_endpoint === undefined ? [] : [discovery.thread_import_endpoint]),
    ...(discovery.thread_export_endpoint === undefined ? [] : [discovery.thread_export_endpoint]),
    ...(discovery.thread_settle_endpoint === undefined ? [] : [discovery.thread_settle_endpoint]),
    ...[
      discovery.thread_start_endpoint,
      discovery.thread_wait_endpoint,
      discovery.thread_message_endpoint,
      discovery.thread_stop_endpoint,
      discovery.thread_check_endpoint,
      discovery.machine_status_endpoint,
      discovery.machine_start_endpoint,
      discovery.models_endpoint,
      discovery.worker_machines_endpoint,
    ].filter((address) => address !== undefined),
  ];
  if (!calls.every((address) => on(address, secure ? "https:" : "http:")))
    return { ok: false, why: "The server sends Gram to another address." };
  if (!on(discovery.device_connect, secure ? "wss:" : "ws:"))
    return { ok: false, why: "The server sends Gram to another address." };
  if (
    discovery.worker_machine_connect !== undefined &&
    !on(discovery.worker_machine_connect, secure ? "wss:" : "ws:")
  )
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

/**
 * `POST thread_import_endpoint`: a thread this machine exported (`ThreadBundle`), into a workspace
 * the person picked there, and the name the server shows as where it came from.
 */
export interface HostedThreadImport {
  readonly workspaceId: string;
  readonly bundle: unknown;
  readonly from: string;
}

/** Its answer: the thread there, what to tell the person, and where to open it when the server says. */
export const HostedThreadImported = Schema.Struct({
  threadId: Id,
  notes: Schema.optionalKey(Schema.Array(Text(1000)).check(Schema.isMaxLength(20))),
  url: Schema.optionalKey(Address),
});
export type HostedThreadImported = typeof HostedThreadImported.Type;

/** `POST thread_export_endpoint`: a thread of a workspace there, to bring back to this machine. */
export interface HostedThreadExport {
  readonly workspaceId: string;
  readonly threadId: string;
}

/** Its answer: the thread as a bundle, which this machine's own server reads and checks. */
export const HostedThreadExported = Schema.Struct({ bundle: Schema.Unknown });

/** `POST thread_settle_endpoint`: the thread is here now, so its copy there becomes read-only. */
export interface HostedThreadSettle {
  readonly workspaceId: string;
  readonly threadId: string;
  /** The bundle's `exportedAt`: a thread that carried on there since stays as it is. */
  readonly exportedAt: number;
  /** This machine's name, as the copy there says where it went. */
  readonly to: string;
}

/** A thread's id there, as Gram names one in its calls back: no path, no space. */
export const HOSTED_THREAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Whether the server runs work sent from this machine: it names all four calls for it. */
export const runsSentWork = (discovery: HostedDiscovery): boolean =>
  discovery.thread_start_endpoint !== undefined &&
  discovery.thread_wait_endpoint !== undefined &&
  discovery.thread_message_endpoint !== undefined &&
  discovery.thread_stop_endpoint !== undefined;

/** Whether the server starts machines for this machine's workers: it names both addresses. */
export const startsWorkerMachines = (discovery: HostedDiscovery): boolean =>
  discovery.worker_machines_endpoint !== undefined &&
  discovery.worker_machine_connect !== undefined;

/**
 * How a hosted Gram that runs no work itself begins its refusal of work for a person with no
 * machine running (`host/headless.ts`): a send that started their machine sends again on it.
 */
export const NO_MACHINE_RUNNING = "You have no machine running";

/**
 * How a hosted Gram begins its refusal to open the orchestrator of a workspace whose own machine
 * isn't running (`embedding/workspace-machines.ts`): the app starts it as the person, then opens it
 * again.
 */
export const WORKSPACE_MACHINE_NOT_RUNNING = "This workspace's machine isn't running";

/** Whether the server starts the person's own machine from here: it names both calls for it. */
export const startsMachines = (discovery: HostedDiscovery): boolean =>
  discovery.machine_status_endpoint !== undefined && discovery.machine_start_endpoint !== undefined;

/**
 * The person's own machine in a workspace there, as `machine_status_endpoint` and
 * `machine_start_endpoint` answer: where it stands (`none` when they have none, `running` once it
 * runs) and whether a start of it is under way. Read leniently: a phase Gram doesn't know is the
 * server's word, shown as it is. All the server's word.
 */
export const HostedMachine = Schema.Struct({
  phase: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  starting: Schema.optionalKey(Schema.Boolean),
});
export type HostedMachine = typeof HostedMachine.Type;

/** Whether work sent there now has a machine to run on: it runs, and no start is under way. */
export const hostedMachineReady = (machine: HostedMachine): boolean =>
  machine.phase === "running" && machine.starting !== true;

/** Whether the machine won't come up without another start: none, stopped, or failed. */
export const hostedMachineDown = (machine: HostedMachine): boolean =>
  machine.starting !== true && ["none", "stopping", "stopped", "failed"].includes(machine.phase);

/**
 * `POST thread_start_endpoint`: work sent from this machine, as a new thread of a workspace there,
 * in the repositories it names (`owner/name` or a git URL, the main one first). `clientKey` names
 * the send: sent again, the server answers the thread it made, so a retry starts one.
 */
export interface HostedThreadStart {
  readonly workspaceId: string;
  readonly repositories: readonly string[];
  readonly text: string;
  readonly title?: string;
  readonly branch?: string;
  readonly clientKey: string;
}

/** Its answer: the thread there, and the branch its work is on. */
export const HostedThreadStarted = Schema.Struct({
  threadId: Schema.String.check(Schema.isPattern(HOSTED_THREAD_ID)),
  branch: Schema.optionalKey(Text(200)),
});
export type HostedThreadStarted = typeof HostedThreadStarted.Type;

/** A message's id there: what a wait starts after. */
const MessageRef = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,200}$/));

/**
 * `POST thread_wait_endpoint`: waits, at most `timeoutSeconds` (20 at most), for a thread sent from
 * here to reply (`reply`), stop working (`idle`), wait on a person (`waiting`) or say anything
 * (`message`), after the message `after`.
 */
export interface HostedThreadWait {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly after?: string;
  readonly until?: "reply" | "idle" | "waiting" | "message";
  readonly timeoutSeconds?: number;
}

/** Where a thread there stands: `waiting` is waiting on a person there. All the server's word. */
export const HOSTED_THREAD_STATES = ["running", "waiting", "done", "failed", "stopped"] as const;
export type HostedThreadState = (typeof HOSTED_THREAD_STATES)[number];

const cut = (most: number) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((text: string) => [...text].slice(0, most).join("")),
      encode: SchemaGetter.transform((value) => value),
    }),
  );

/**
 * Its answer: whether it happened, the last message to wait after, its last reply, and the thread.
 * Read leniently, so a long reply or a state Gram doesn't know never stops it following the thread:
 * words are cut to length, and a state it doesn't know reads as `running`.
 */
export const HostedThreadWaited = Schema.Struct({
  happened: Schema.Boolean,
  latest: Schema.optionalKey(MessageRef),
  reply: Schema.optionalKey(cut(8000)),
  thread: Schema.Struct({
    title: cut(200),
    state: Schema.String.pipe(
      Schema.decodeTo(Schema.Literals(HOSTED_THREAD_STATES), {
        decode: SchemaGetter.transform((state: string) =>
          (HOSTED_THREAD_STATES as readonly string[]).includes(state)
            ? (state as HostedThreadState)
            : "running",
        ),
        encode: SchemaGetter.transform((value) => value),
      }),
    ),
    working: Schema.Boolean,
  }),
});
export type HostedThreadWaited = typeof HostedThreadWaited.Type;

/**
 * `POST thread_message_endpoint`: a message into a thread sent from here, as the person typed it.
 * `queue` waits for a running turn to end; `interrupt` stops it and answers this.
 */
export interface HostedThreadMessage {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly text: string;
  readonly mode?: "queue" | "steer" | "interrupt";
  readonly clientKey: string;
}

/** Its answer: whether it waits behind a running turn, and the message a wait for its reply starts after. */
export const HostedThreadMessaged = Schema.Struct({
  queued: Schema.optionalKey(Schema.Boolean),
  after: Schema.optionalKey(MessageRef),
});
export type HostedThreadMessaged = typeof HostedThreadMessaged.Type;

/** `POST thread_stop_endpoint`: stops the turn a thread sent from here is working on. It stays. */
export interface HostedThreadStop {
  readonly workspaceId: string;
  readonly threadId: string;
}

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

// ---------------------------------------------------------------------------------------------
// Work sent from this machine's server to a hosted server, through the desktop app, which holds
// the sign-in. The server asks over its parent port; the app answers by id.

/** A hosted workspace this machine may send work to: signed in, not paused, and its server runs it. */
export interface SentWorkTarget {
  readonly origin: string;
  /** What the server calls itself, as the app shows it. */
  readonly server: string;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly organisation: string;
}

/** The work an orchestrator sends, as the app passes it on. */
export interface SentWorkBrief {
  readonly repositories: readonly string[];
  readonly text: string;
  readonly title?: string;
  readonly branch?: string;
  readonly clientKey: string;
}

/** Whether a thread there could clone each repository and push its branch, as the server says. */
export const HostedRepositoryReach = Schema.Struct({
  connected: Schema.Boolean,
  items: Schema.Array(
    Schema.Struct({
      repository: Schema.String.check(Schema.isMaxLength(512)),
      reach: Schema.Literals(["yes", "no", "unknown"]),
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
    }),
  ).check(Schema.isMaxLength(8)),
  /**
   * The model a thread started in that workspace now would open on, when the server could say:
   * what a sent worker runs on. Absent from a server that doesn't, or while it can't tell.
   */
  model: Schema.optionalKey(
    Schema.Struct({
      agent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
      model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    }),
  ),
});
export type HostedRepositoryReach = typeof HostedRepositoryReach.Type;

export type SentWorkOp =
  | { readonly op: "targets" }
  | {
      readonly op: "check";
      readonly origin: string;
      readonly workspaceId: string;
      readonly repositories: readonly string[];
    }
  | {
      readonly op: "send";
      readonly origin: string;
      readonly workspaceId: string;
      readonly work: SentWorkBrief;
    }
  | {
      readonly op: "wait";
      readonly origin: string;
      readonly workspaceId: string;
      readonly threadId: string;
      readonly after?: string;
      readonly until?: "reply" | "idle" | "waiting" | "message";
      readonly timeoutSeconds?: number;
    }
  | {
      readonly op: "message";
      readonly origin: string;
      readonly workspaceId: string;
      readonly threadId: string;
      readonly text: string;
      readonly clientKey: string;
      readonly mode?: "queue" | "steer" | "interrupt";
    }
  | {
      readonly op: "stop";
      readonly origin: string;
      readonly workspaceId: string;
      readonly threadId: string;
    }
  | {
      /** The person's own machine there: read, or started unless it runs. Never stopped. */
      readonly op: "machine";
      readonly origin: string;
      readonly workspaceId: string;
      readonly action: "get" | "start";
    };

export type SentWorkRequestMessage = {
  readonly type: "work.request";
  readonly id: string;
} & SentWorkOp;

/** Each op's answer. `unknown`: no clear answer, so the call may be made again with its key. */
export type SentWorkResult =
  | { readonly ok: true; readonly targets: ReadonlyArray<SentWorkTarget> }
  | { readonly ok: true; readonly reach: HostedRepositoryReach }
  | { readonly ok: true; readonly threadId: string; readonly branch?: string }
  | { readonly ok: true; readonly waited: HostedThreadWaited }
  | { readonly ok: true; readonly queued: boolean; readonly after?: string }
  /** `unoffered`: the server starts no machine from here. */
  | { readonly ok: true; readonly machine: HostedMachine | "unoffered" }
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

export interface SentWorkResponseMessage {
  readonly type: "work.response";
  readonly id: string;
  readonly result: SentWorkResult;
}

// ---------------------------------------------------------------------------------------------
// Machines of a worker's own, which this machine's orchestrators ask a hosted server for, through
// the desktop app, which holds the sign-in (`docs/design/desktop-worker-machines.md`). The server
// asks over its parent port and the app answers by id; the app carries each machine's connection
// to the server as frames over the same port.

/** The calls a worker machine is asked for and looked after with, under `worker_machines_endpoint`. */
export const WORKER_MACHINE_CALLS = ["choices", "start", "status", "release", "stop"] as const;
export type WorkerMachineCall = (typeof WORKER_MACHINE_CALLS)[number];

/** A worker machine's name, as the server picks it (`worker-` and hex). */
export const WORKER_MACHINE_NAME = /^worker-[a-z0-9]{8,16}$/;

/** The server a worker machine may be asked of: signed in, not paused, and it starts them. */
export interface WorkerMachineServer {
  readonly origin: string;
  /** What the server calls itself, as the app shows it. */
  readonly server: string;
}

export type WorkerMachineOp =
  /** Which server, if any, worker machines may be asked of now. */
  | { readonly op: "server" }
  /** One call to the server, answered with its status and JSON body as received. */
  | {
      readonly op: "call";
      readonly origin: string;
      readonly call: WorkerMachineCall;
      readonly body: Readonly<Record<string, unknown>>;
      /**
       * The latest time (milliseconds since the epoch) the app may send it: past it, after a
       * token renewal say, it isn't sent at all. A stop carries one, so a stop that comes late
       * can never land after the time its sender held the name for.
       */
      readonly sendBy?: number;
    }
  /** Keep carrying this machine's connection, dialling the relay again whenever it ends. */
  | { readonly op: "relay"; readonly origin: string; readonly name: string }
  /** Stop carrying it. */
  | { readonly op: "unrelay"; readonly name: string }
  /**
   * Carry exactly these, and no others: what the server has registered. `fresh` from a server that
   * has just started, which knows none of the connections carried for the one before it, so each
   * is dialled again.
   */
  | {
      readonly op: "relays";
      readonly machines: ReadonlyArray<{ readonly origin: string; readonly name: string }>;
      readonly fresh?: true;
    };

export type WorkerMachineRequestMessage = {
  readonly type: "machines.request";
  readonly id: string;
} & WorkerMachineOp;

/**
 * Each op's answer. `server` answers the server, or none with why; `call`, the server's status and
 * body (at most 256 KiB, read as JSON, `undefined` when it isn't); `signIn`: the person must sign
 * in to it again first.
 */
export type WorkerMachineResult =
  | { readonly ok: true; readonly server?: WorkerMachineServer; readonly why?: string }
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string; readonly signIn?: true };

export interface WorkerMachineResponseMessage {
  readonly type: "machines.response";
  readonly id: string;
  readonly result: WorkerMachineResult;
}

/**
 * A relayed connection's messages. The app says a host dialled (`dial`, with the headers the host
 * signed its dial with, as the server relayed them), then each frame, and its end; the server sends
 * frames back and may end it. `conn` names one connection, made by the app.
 */
export type WorkerMachineRelayMessage =
  | {
      readonly type: "machines.relay.dial";
      readonly conn: string;
      readonly origin: string;
      readonly name: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "machines.relay.frame";
      readonly conn: string;
      readonly data: string | Uint8Array;
    }
  | {
      readonly type: "machines.relay.end";
      readonly conn: string;
      readonly code?: number;
      readonly reason?: string;
    };

const RelayHeader = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

/**
 * The first frame the relay sends the app: the headers the host signed its dial with, exactly
 * these four, which this machine's server checks against the host's key.
 */
export const RelayDialFrame = Schema.Struct({
  dial: Schema.Struct({
    headers: Schema.Struct({
      "x-gram-host-id": RelayHeader,
      "x-gram-host-time": RelayHeader,
      "x-gram-host-nonce": RelayHeader,
      "x-gram-host-signature": RelayHeader,
    }),
  }),
});
export type RelayDialFrame = typeof RelayDialFrame.Type;
