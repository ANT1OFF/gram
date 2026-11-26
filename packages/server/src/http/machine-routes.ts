import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  HOST_PROTOCOL_VERSION,
  HostFailed,
  HostId,
  InvalidState,
  LOCAL_HOST_ID,
  NotFound,
  sessionHostOf,
} from "@gram/contracts";
import {
  type ClaudeTokenCapture,
  makeClaudeTokenCapture,
  type StartSetupToken,
} from "../host/claude-token-capture.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  fingerprintOf,
  HOST_CONNECT_PATH,
  HOST_INSTALL_PATH,
  HOST_JOIN_PATH,
  HOST_MCP_PATH,
} from "../host/machine-keys.ts";
import {
  printedFingerprint,
  runOverSsh,
  sshConfigHosts,
  type SshJoinFailed,
  SSH_TARGET,
} from "../host/ssh-join.ts";
import { installScript, updateCommand } from "../host/install-script.ts";
import type { DialAccess, DialRoute } from "../host/paired-machines.ts";
import { type HostFolders, MAX_LISTED } from "../host/folders.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { McpTokens } from "../app-tools/mcp-tokens.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { bearerToken } from "./auth.ts";
import type { RemoteAccess } from "./remote-access.ts";
import * as Predicate from "effect/Predicate";

export const MACHINES_LIST_PATH = "/machines/list";
export const MACHINES_JOIN_LINK_PATH = "/machines/join-link";
export const MACHINES_CONFIRM_PATH = "/machines/confirm";
export const MACHINES_REMOVE_PATH = "/machines/remove";
export const MACHINES_SSH_HOSTS_PATH = "/machines/ssh-hosts";
export const MACHINES_SSH_JOIN_PATH = "/machines/ssh-join";
export const MACHINES_TOKEN_START_PATH = "/machines/claude-token/start";
export const MACHINES_TOKEN_STATUS_PATH = "/machines/claude-token/status";
export const MACHINES_TOKEN_CODE_PATH = "/machines/claude-token/code";
export const MACHINES_TOKEN_CANCEL_PATH = "/machines/claude-token/cancel";
export const MACHINES_TOKEN_FORGET_PATH = "/machines/claude-token/forget";

/**
 * What a start must carry to show the person agreed to the consent dialog: a literal, so a call
 * that merely names machines starts nothing.
 */
export const TOKEN_CONSENT = "send-claude-token-to-these-machines";
export const MACHINES_UPDATE_PATH = "/machines/update";
/** Updates every joined machine that can update itself and runs an earlier release. */
export const MACHINES_UPDATE_ALL_PATH = "/machines/update-all";
/** Turns joined machines updating on their own on or off. Local app only, like every route here. */
export const MACHINES_AUTOMATIC_UPDATES_PATH = "/machines/automatic-updates";
/** Asks a machine for its Claude Code sign-in again, as after its Sign in terminal ends. */
export const MACHINES_CHECK_SIGN_IN_PATH = "/machines/check-sign-in";
/**
 * Lets the disk this Gram last refused a host of the machine on back in as that machine, at that
 * host's next dial within fifteen minutes (`StopMarks.readmit`): `{ id }`, answered with the disk.
 * For a host nobody can run `gram-host new-disk` on. Its resume checks its folders.
 */
export const MACHINES_READMIT_PATH = "/machines/readmit";

/**
 * Registers a provisioned host by the public key it made (`gram-host provision`): confirmed from
 * the start, with no join link. Local app only, like every route here, and only while this Gram
 * listens for provisioned hosts.
 */
export const MACHINES_PROVISION_PATH = "/machines/provision";

/**
 * A joined machine's folders for a one-off chat's picker, listed there by its host. Local app
 * only: a paired phone never lists or checks another machine's folders.
 */
export const MACHINES_FOLDERS_BROWSE_PATH = "/machines/folders/browse";
/** Whether a one-off chat may run in a folder on a joined machine, checked there by its host. */
export const MACHINES_FOLDERS_CHECK_PATH = "/machines/folders/check";

/** Machines settings: only the local app may call them, never a paired browser or a machine. */
export const MACHINE_MANAGEMENT_PATHS: ReadonlySet<string> = new Set([
  MACHINES_FOLDERS_BROWSE_PATH,
  MACHINES_FOLDERS_CHECK_PATH,
  MACHINES_LIST_PATH,
  MACHINES_JOIN_LINK_PATH,
  MACHINES_CONFIRM_PATH,
  MACHINES_REMOVE_PATH,
  MACHINES_PROVISION_PATH,
  MACHINES_SSH_HOSTS_PATH,
  MACHINES_SSH_JOIN_PATH,
  MACHINES_TOKEN_START_PATH,
  MACHINES_TOKEN_STATUS_PATH,
  MACHINES_TOKEN_CODE_PATH,
  MACHINES_TOKEN_CANCEL_PATH,
  MACHINES_TOKEN_FORGET_PATH,
  MACHINES_UPDATE_PATH,
  MACHINES_UPDATE_ALL_PATH,
  MACHINES_AUTOMATIC_UPDATES_PATH,
  MACHINES_CHECK_SIGN_IN_PATH,
  MACHINES_READMIT_PATH,
]);

/**
 * The capture of `claude setup-token` for this server's joined machines. Each token goes over the
 * machine's own connection, only to the join the person consented to, and only once the machine
 * is recorded as one that may hold it (a time, never the token).
 */
export const claudeTokenCaptureFor = (hosts: RemoteHostsShape, start?: StartSetupToken) =>
  makeClaudeTokenCapture({
    ...(start === undefined ? {} : { start }),
    send: (id, token) =>
      hosts.connection(HostId.make(id)).pipe(
        Effect.mapError((error) => new HostFailed({ message: error.message })),
        Effect.flatMap((connection) => connection.claude.setToken(token)),
      ),
    mark: (id) => hosts.machines.tokenSent(id, true),
    joinOf: (id) => {
      const machine = hosts.machines.get(id);
      return machine?.confirmedAt === undefined
        ? undefined
        : `${machine.publicKey}:${machine.joinedAt}:${machine.confirmedAt}`;
    },
  });

const SIGN_IN_CODE = /^[A-Za-z0-9#._~+/=-]{1,512}$/;

const forgetOn = (hosts: RemoteHostsShape, id: string) =>
  hosts.connection(HostId.make(id)).pipe(
    Effect.flatMap((connection) => connection.claude.forgetToken),
    Effect.map(() => {
      try {
        hosts.machines.tokenSent(id, false);
      } catch (_onlyTheRecordTheMachineDeletedIt) {}
      return true;
    }),
    Effect.orElseSucceed(() => false),
  );

/** What a joining machine's host reaches: answered before any browser auth, by its own rules. */
export const HOST_PATHS: ReadonlySet<string> = new Set([
  HOST_JOIN_PATH,
  HOST_CONNECT_PATH,
  HOST_INSTALL_PATH,
]);

const encodeNotFound = Schema.encodeSync(NotFound);
const encodeInvalidState = Schema.encodeSync(InvalidState);
const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const refuse = (message: string, status = 403) => HttpServerResponse.text(message, { status });

const JOIN_BODY_MAX = 512;
const OWNER = /^[\x21-\x7e]{1,128}$/;
const FOLDER_BODY_MAX = 8_192;

const jsonBody = (max: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"] ?? max + 1) > max) return undefined;
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(max)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return Predicate.isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  });

const fromAHost = (request: HttpServerRequest.HttpServerRequest, remote: RemoteAccess) =>
  request.headers["host"] === remote.host && request.headers["origin"] === undefined;

/**
 * Answers `/host/install`, `/host/join` and `/host/connect` on the tailnet address. A join must carry the current
 * join link's code; a dial must be signed by a joined, confirmed machine's key. Neither is ever
 * answered on loopback, and neither takes a browser's cookie.
 */
export const hostRoute = (
  hosts: RemoteHostsShape,
  remote: RemoteAccess,
  path: string,
  appVersion?: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromAHost(request, remote)) return refuse("forbidden");
    if (path === HOST_INSTALL_PATH) {
      if (request.method !== "GET") return refuse("forbidden");
      return HttpServerResponse.text(installScript(remote.origin, appVersion), {
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (path === HOST_JOIN_PATH) {
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json")
        return refuse("forbidden");
      const body = yield* jsonBody(JOIN_BODY_MAX);
      const { code, name, platform, publicKey } = body ?? {};
      if (
        typeof code !== "string" ||
        code.length !== 64 ||
        typeof name !== "string" ||
        typeof platform !== "string" ||
        typeof publicKey !== "string"
      )
        return refuse("bad request", 400);
      const result = (() => {
        try {
          return hosts.machines.join(remote.origin, { code, name, platform, publicKey });
        } catch {
          return undefined;
        }
      })();
      if (result === undefined) return refuse("The machine couldn't be saved.", 500);
      if (result.kind === "refused") return refuse(result.message, result.status);
      return json({ hostId: result.machine.id });
    }
    return yield* dialIn(hosts, remote.origin, "joined");
  });

const dialIn = (hosts: RemoteHostsShape, origin: string, route: DialRoute) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET") return refuse("forbidden");
    if (
      request.headers["upgrade"]?.toLowerCase() !== "websocket" ||
      !/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(request.headers["connection"] ?? "")
    )
      return refuse("WebSocket required", 400);
    const decision = hosts.machines.authorizeConnect(origin, request.headers, route);
    if (decision.kind === "refused") return refuse(decision.message, decision.status);
    const dial = hosts.admit(decision.machine, origin);
    const socket = yield* request.upgrade.pipe(Effect.option);
    if (socket._tag === "None") return refuse("WebSocket required", 400);
    yield* hosts.attach(dial, socket.value);
    return HttpServerResponse.empty();
  });

/**
 * Answers a request that came in on the provisioned-host listener. That listener serves two
 * things and nothing else: a registered host's signed dial, and a session on such a host reaching
 * its thread's app tools (`mcp`, which the caller passes already limited to that). No join, no
 * installer, no browser: a request with an `Origin`, for another name than the listener's, or for
 * any other path is refused, as is every request while provisioned hosts are off.
 */
export const provisionedRoute = <E, R>(
  hosts: RemoteHostsShape | undefined,
  path: string | undefined,
  on: boolean,
  mcp: (origin: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = hosts?.provisionedOrigin;
    if (
      !on ||
      hosts === undefined ||
      origin === undefined ||
      request.headers["host"] !== new URL(origin).host ||
      request.headers["origin"] !== undefined
    )
      return refuse("forbidden");
    if (path === HOST_CONNECT_PATH) return yield* dialIn(hosts, origin, "provisioned");
    if (path === HOST_MCP_PATH && request.method === "POST") return yield* mcp(origin);
    return refuse("forbidden");
  });

const MOVED_SERVICE = /^gram-host: This machine already joined \S+; moving its service/m;

/**
 * The machine an install over SSH joined: the new one whose key has the fingerprint the install
 * printed into the session; `rejoined` when it printed none and said it moved the service of a
 * machine already joined; undefined otherwise, which is never confirmed.
 */
export const joinedOverSsh = <M extends { readonly id: string; readonly publicKey: string }>(
  before: ReadonlySet<string>,
  machines: ReadonlyArray<M>,
  output: string,
): M | "rejoined" | undefined => {
  const printed = printedFingerprint(output);
  const fresh =
    printed === undefined
      ? undefined
      : machines.find(
          (machine) => !before.has(machine.id) && fingerprintOf(machine.publicKey) === printed,
        );
  if (fresh !== undefined) return fresh;
  return MOVED_SERVICE.test(output) ? "rejoined" : undefined;
};

/**
 * The joined machine whose service an install over SSH moved: the one already here whose key has
 * the fingerprint it printed after it said so. Undefined when it printed none or another.
 */
export const movedOverSsh = <M extends { readonly publicKey: string }>(
  machines: ReadonlyArray<M>,
  output: string,
): M | undefined => {
  const printed = printedFingerprint(output);
  if (printed === undefined || !MOVED_SERVICE.test(output)) return undefined;
  return machines.find((machine) => fingerprintOf(machine.publicKey) === printed);
};

let sshJoinRunning = false;
const SSH_JOIN_BUSY = {
  reason: "ssh-running",
  message: "Gram is adding a machine over SSH. Try again once that finishes.",
};

const machinesStatus = (
  hosts: RemoteHostsShape,
  remote: RemoteAccess | undefined,
  release: string | undefined,
  access: DialAccess | undefined,
) => {
  const joinLink = hosts.machines.joinOpen();
  return {
    machines: hosts
      .list(access ?? (remote !== undefined ? "on" : "off"))
      .filter((machine) => hosts.machines.get(machine.id)?.setAside === undefined),
    ...(joinLink === undefined ? {} : { joinLink }),
    protocol: HOST_PROTOCOL_VERSION,
    ...(release === undefined ? {} : { release }),
    ...(remote === undefined ? {} : { updateCommand: updateCommand(remote.origin) }),
    automaticUpdates: hosts.automaticUpdates(),
  };
};

const sshFailure = (ran: Exit.Exit<string, SshJoinFailed>) => {
  const failure =
    ran._tag === "Failure"
      ? ran.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      : undefined;
  return { failure, output: ran._tag === "Success" ? ran.value : (failure?.output ?? "") };
};

/**
 * Answers an authorized `/machines/*` request from the local app. Every call is a POST with an
 * Origin, as the phone settings' are, so another page can neither read nor forge one. A join link
 * needs access over Tailscale on: it carries the tailnet address the machine dials.
 */
export const machineManagement = (
  hosts: RemoteHostsShape,
  remote: RemoteAccess | undefined,
  path: string,
  appVersion?: string,
  ssh?: string,
  capture?: ClaudeTokenCapture,
  access?: DialAccess,
  folders?: (id: HostId) => HostFolders,
  provisionedOn = false,
  provisionedOnly = false,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST" || request.headers["origin"] === undefined)
      return refuse("forbidden");
    switch (path) {
      case MACHINES_LIST_PATH:
        return json(machinesStatus(hosts, remote, appVersion, access));
      case MACHINES_FOLDERS_BROWSE_PATH:
      case MACHINES_FOLDERS_CHECK_PATH: {
        const body = yield* jsonBody(FOLDER_BODY_MAX);
        const id = body?.["id"];
        const folder = body?.["path"];
        const limit = body?.["limit"];
        if (typeof id !== "string" || typeof folder !== "string")
          return json({ message: "Say which machine and which folder." }, 400);
        const machine = hosts.machines.get(id);
        if (machine === undefined || machine.confirmedAt === undefined || folders === undefined)
          return refuse("no such machine", 404);
        const on = folders(HostId.make(id));
        const answer: Effect.Effect<unknown, NotFound | InvalidState> =
          path === MACHINES_FOLDERS_BROWSE_PATH
            ? on.browse(folder, typeof limit === "number" && limit > 0 ? limit : MAX_LISTED)
            : on.check(folder);
        return yield* answer.pipe(
          Effect.map((value) => json(value)),
          Effect.catch((error) =>
            Effect.succeed(
              error._tag === "NotFound"
                ? json(encodeNotFound(error), 404)
                : json(encodeInvalidState(new InvalidState({ message: error.message })), 422),
            ),
          ),
        );
      }
      case MACHINES_PROVISION_PATH: {
        const origin = hosts.provisionedOrigin;
        if (!provisionedOn || origin === undefined)
          return json(
            {
              reason: "provisioned-off",
              message: "Provisioned hosts aren't turned on for this Gram.",
            },
            409,
          );
        const body = yield* jsonBody(JOIN_BODY_MAX);
        const {
          name,
          publicKey,
          platform = "linux",
          owner,
          person,
          answeredBy,
          onDemand,
        } = body ?? {};
        if (
          typeof name !== "string" ||
          typeof publicKey !== "string" ||
          typeof platform !== "string"
        )
          return json({ message: "Give the host's name and its public key." }, 400);
        if (
          (owner !== undefined && (typeof owner !== "string" || !OWNER.test(owner))) ||
          (onDemand !== undefined &&
            onDemand !== "personal" &&
            onDemand !== "thread" &&
            onDemand !== "worker") ||
          (owner !== undefined && onDemand === undefined) ||
          (onDemand !== undefined && owner === undefined) ||
          (person !== undefined &&
            (typeof person !== "string" || !OWNER.test(person) || owner === undefined)) ||
          (answeredBy !== undefined && (answeredBy !== "members" || owner === undefined))
        )
          return json({ message: "An on-demand host names its kind and its owner." }, 400);
        const result = (() => {
          try {
            return hosts.machines.provision({
              name,
              publicKey,
              platform,
              ...(typeof owner === "string" ? { owner } : {}),
              ...(typeof person === "string" ? { person } : {}),
              ...(answeredBy === "members" ? { answeredBy } : {}),
              ...(onDemand === "personal" || onDemand === "thread" || onDemand === "worker"
                ? { onDemand }
                : {}),
            });
          } catch {
            return undefined;
          }
        })();
        if (result === undefined) return json({ message: "The host couldn't be saved." }, 500);
        if (result.kind === "refused") return json({ message: result.message }, result.status);
        return json({
          hostId: result.machine.id,
          fingerprint: fingerprintOf(result.machine.publicKey),
          created: result.created,
          origin,
        });
      }
      case MACHINES_JOIN_LINK_PATH:
        if (remote === undefined)
          return json(
            { reason: "tailscale-off", message: "Turn on access over Tailscale first." },
            409,
          );
        if (sshJoinRunning) return json(SSH_JOIN_BUSY, 409);
        return json(hosts.machines.mint(remote.origin));
      case MACHINES_SSH_HOSTS_PATH:
        return json({ hosts: sshConfigHosts() });
      case MACHINES_SSH_JOIN_PATH: {
        if (remote === undefined)
          return json(
            { reason: "tailscale-off", message: "Turn on access over Tailscale first." },
            409,
          );
        const target = (yield* jsonBody(256))?.["target"];
        if (typeof target !== "string" || !SSH_TARGET.test(target))
          return json({ message: "That isn't a host to SSH to." }, 400);
        if (sshJoinRunning) return json(SSH_JOIN_BUSY, 409);
        const before = new Set(hosts.machines.list().map((machine) => machine.id));
        const link = hosts.machines.mint(remote.origin);
        const script = installScript(remote.origin, appVersion, { link: link.url });
        sshJoinRunning = true;
        const ran = yield* runOverSsh(target, script, ssh === undefined ? {} : { ssh }).pipe(
          Effect.exit,
          Effect.ensuring(Effect.sync(() => (sshJoinRunning = false))),
        );
        const { failure, output } = sshFailure(ran);
        const joined = joinedOverSsh(before, hosts.machines.list(), output);
        if (ran._tag === "Failure" && (joined === undefined || joined === "rejoined"))
          return json({ message: failure?.message ?? "The install over SSH failed.", output }, 502);
        if (joined === "rejoined") {
          const moved = movedOverSsh(hosts.machines.list(), output);
          try {
            if (moved !== undefined) hosts.machines.installedOverSsh(moved.id, target);
          } catch (_onlyWhatItsUpdateRunsIsLostTheMove) {}
          return json({ ...machinesStatus(hosts, remote, appVersion, access), joined, output });
        }
        if (joined === undefined)
          return json(
            {
              message:
                printedFingerprint(output) === undefined
                  ? "The install didn't print the machine's fingerprint, so nothing was confirmed. If a machine joined, check its fingerprint before you confirm it."
                  : "The machine that joined isn't the one Gram installed over SSH, so it wasn't confirmed. Remove it, and add the machine again.",
              output,
            },
            409,
          );
        try {
          hosts.machines.confirm(joined.id);
          hosts.machines.installedOverSsh(joined.id, target);
        } catch {
          return json({ message: "The change couldn't be saved.", output }, 500);
        }
        return json({
          ...machinesStatus(hosts, remote, appVersion, access),
          joined: joined.id,
          ...(failure === undefined
            ? {}
            : {
                problem:
                  "It joined and was confirmed, but the install didn't finish after that, so its background service may not be running. Add it over SSH again, or run `gram-host service install` there.",
              }),
          output,
        });
      }
      case MACHINES_AUTOMATIC_UPDATES_PATH: {
        const enabled = (yield* jsonBody(64))?.["enabled"];
        if (typeof enabled !== "boolean") return json({ message: "Say on or off." }, 400);
        try {
          hosts.setAutomaticUpdates(enabled);
        } catch {
          return json({ message: "The change couldn't be saved." }, 500);
        }
        return json(machinesStatus(hosts, remote, appVersion, access));
      }
      case MACHINES_UPDATE_ALL_PATH: {
        for (const machine of hosts.machines.list())
          if (machine.confirmedAt !== undefined) hosts.update(machine.id);
        return json(machinesStatus(hosts, remote, appVersion, access));
      }
      case MACHINES_UPDATE_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        const machine = typeof id === "string" ? hosts.machines.get(id) : undefined;
        if (machine === undefined) return refuse("no such machine", 404);
        if (machine.confirmedAt !== undefined) {
          const asked = hosts.update(machine.id);
          if (asked.kind === "started" || asked.kind === "current")
            return json({
              ...machinesStatus(hosts, remote, appVersion, access),
              output: "",
              started: true,
            });
          if (asked.kind === "unavailable" && appVersion === undefined)
            return json({ reason: "no-release", message: asked.message }, 409);
        }
        if (remote === undefined)
          return json(
            { reason: "tailscale-off", message: "Turn on access over Tailscale first." },
            409,
          );
        const target = machine.sshTarget;
        if (target === undefined)
          return json(
            {
              reason: "not-ssh",
              message: `Gram didn't add ${machine.name} over SSH. Run the update command there.`,
            },
            409,
          );
        if (sshJoinRunning) return json(SSH_JOIN_BUSY, 409);
        const script = installScript(remote.origin, appVersion, { update: true });
        sshJoinRunning = true;
        const ran = yield* runOverSsh(target, script, ssh === undefined ? {} : { ssh }).pipe(
          Effect.exit,
          Effect.ensuring(Effect.sync(() => (sshJoinRunning = false))),
        );
        const { failure, output } = sshFailure(ran);
        if (failure !== undefined || ran._tag === "Failure")
          return json({ message: failure?.message ?? "The update over SSH failed.", output }, 502);
        if (movedOverSsh([machine], output) === undefined)
          return json(
            {
              message: `The install on ${target} didn't print ${machine.name}'s fingerprint, so it may have updated another machine. Run the update command on ${machine.name} itself.`,
              output,
            },
            409,
          );
        return json({ ...machinesStatus(hosts, remote, appVersion, access), output });
      }
      case MACHINES_READMIT_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        const machine = typeof id === "string" ? hosts.machines.get(id) : undefined;
        if (typeof id !== "string" || machine === undefined) return refuse("no such machine", 404);
        if (provisionedOnly && machine.kind !== "provisioned")
          return refuse("no such machine", 404);
        let disk: string | undefined;
        try {
          disk = hosts.stops.readmit(HostId.make(id));
        } catch {
          return json({ message: "The machine's record couldn't be kept; try again." }, 503);
        }
        return disk === undefined
          ? json({ message: "No host of this machine has been refused since Gram started." }, 409)
          : json({ disk });
      }
      case MACHINES_CHECK_SIGN_IN_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        if (typeof id !== "string" || hosts.machines.get(id) === undefined)
          return refuse("no such machine", 404);
        yield* Effect.promise(() => hosts.checkSignIn(HostId.make(id)));
        return json(machinesStatus(hosts, remote, appVersion, access));
      }
      case MACHINES_CONFIRM_PATH:
      case MACHINES_REMOVE_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        const machine = typeof id === "string" ? hosts.machines.get(id) : undefined;
        if (typeof id !== "string" || machine === undefined) return refuse("no such machine", 404);
        if (provisionedOnly && machine.kind !== "provisioned")
          return refuse("no such machine", 404);
        if (path === MACHINES_CONFIRM_PATH) {
          try {
            hosts.machines.confirm(id);
          } catch {
            return json({ message: "The change couldn't be saved." }, 500);
          }
          return json(machinesStatus(hosts, remote, appVersion, access));
        }
        const removal = Effect.gen(function* () {
          const forgot = yield* forgetOn(hosts, id);
          const tokenLeft = !forgot && hosts.machines.get(id)?.claudeTokenSetAt !== undefined;
          try {
            hosts.remove(HostId.make(id));
          } catch {
            return json({ message: "The change couldn't be saved." }, 500);
          }
          return json({
            ...machinesStatus(hosts, remote, appVersion, access),
            ...(tokenLeft ? { tokenLeft: true } : {}),
          });
        });
        return yield* capture === undefined
          ? removal
          : capture.holding(id, { drop: true }, removal);
      }
      case MACHINES_TOKEN_FORGET_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        if (typeof id !== "string" || hosts.machines.get(id) === undefined)
          return refuse("no such machine", 404);
        const forgot = yield* capture === undefined
          ? forgetOn(hosts, id)
          : capture.holding(id, { drop: false }, forgetOn(hosts, id));
        if (!forgot)
          return json(
            {
              message:
                "The machine didn't answer, so its token is still there. Try again while it's online, or run `gram-host leave` on it.",
            },
            409,
          );
        return json(machinesStatus(hosts, remote, appVersion, access));
      }
      case MACHINES_TOKEN_START_PATH: {
        if (capture === undefined) return refuse("forbidden");
        const body = yield* jsonBody(4096);
        const ids = body?.["ids"];
        if (body?.["consent"] !== TOKEN_CONSENT)
          return json({ message: "Agree to send the token first." }, 400);
        if (
          !Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 16 ||
          !ids.every((id): id is string => typeof id === "string") ||
          new Set(ids).size !== ids.length
        )
          return json({ message: "Pick the machines to send the token to." }, 400);
        for (const id of ids) {
          const machine = hosts.machines.get(id);
          if (machine === undefined) return refuse("no such machine", 404);
          if (machine.confirmedAt === undefined)
            return json({ message: `Confirm ${machine.name} first.` }, 409);
          if (capture.held(id))
            return json(
              {
                message: `${machine.name} is being removed, or its token deleted. Try again after.`,
              },
              409,
            );
          if ((yield* hosts.connection(HostId.make(id)).pipe(Effect.exit))._tag === "Failure")
            return json(
              { message: `${machine.name} is offline. Pick machines that are online.` },
              409,
            );
        }
        if (capture.busy())
          return json(
            { message: "`claude setup-token` is already running for another sign-in." },
            409,
          );
        return json(yield* capture.begin(ids));
      }
      case MACHINES_TOKEN_STATUS_PATH:
      case MACHINES_TOKEN_CODE_PATH:
      case MACHINES_TOKEN_CANCEL_PATH: {
        if (capture === undefined) return refuse("forbidden");
        const body = yield* jsonBody(1024);
        const captureId = body?.["captureId"];
        if (typeof captureId !== "string") return refuse("bad request", 400);
        if (path === MACHINES_TOKEN_STATUS_PATH) {
          const view = capture.view(captureId);
          return view === undefined ? refuse("no such sign-in", 404) : json(view);
        }
        if (path === MACHINES_TOKEN_CANCEL_PATH)
          return json({ cancelled: capture.cancel(captureId) });
        const code = body?.["code"];
        if (typeof code !== "string" || !SIGN_IN_CODE.test(code.trim()))
          return json({ message: "That isn't a code from the sign-in page." }, 400);
        return capture.answer(captureId, code.trim())
          ? json({ sent: true })
          : json({ message: "It isn't waiting for a code." }, 409);
      }
      default:
        return refuse("forbidden");
    }
  });

/**
 * Whether the request's bearer token is a thread's whose session is on a joined machine that is
 * online now (`sessionHostOf`): what lets a session there reach its app tools over the tailnet.
 */
export const placedOnMachine = (
  tokens: Pick<McpTokens["Service"], "threadFor">,
  store: Pick<ThreadStore["Service"], "getThread"> | undefined,
  remoteHosts: Pick<RemoteHostsShape, "connection"> & Partial<Pick<RemoteHostsShape, "origin">>,
  headers: Readonly<Record<string, string | undefined>>,
  origin?: string,
) =>
  Effect.gen(function* () {
    const bearer = bearerToken(headers);
    if (bearer === undefined || store === undefined) return false;
    const threadId = yield* tokens.threadFor(bearer);
    if (threadId === undefined) return false;
    const thread = yield* store.getThread(threadId).pipe(Effect.option);
    if (thread._tag === "None") return false;
    const hostId = sessionHostOf(thread.value);
    if (hostId === LOCAL_HOST_ID) return false;
    if ((yield* remoteHosts.connection(hostId).pipe(Effect.exit))._tag !== "Success") return false;
    return origin === undefined || remoteHosts.origin?.(hostId) === origin;
  });
