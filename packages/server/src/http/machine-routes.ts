import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { effectiveCheckout, HostId, hostOf, LOCAL_HOST_ID } from "@gram/contracts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  fingerprintOf,
  HOST_CONNECT_PATH,
  HOST_INSTALL_PATH,
  HOST_JOIN_PATH,
} from "../host/machine-keys.ts";
import { printedFingerprint, runOverSsh, sshConfigHosts, SSH_TARGET } from "../host/ssh-join.ts";
import { installScript } from "../host/install-script.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { McpTokens } from "../app-tools/mcp-tokens.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { bearerToken } from "./auth.ts";
import type { RemoteAccess } from "./remote-access.ts";

export const MACHINES_LIST_PATH = "/machines/list";
export const MACHINES_JOIN_LINK_PATH = "/machines/join-link";
export const MACHINES_CONFIRM_PATH = "/machines/confirm";
export const MACHINES_REMOVE_PATH = "/machines/remove";
export const MACHINES_SSH_HOSTS_PATH = "/machines/ssh-hosts";
export const MACHINES_SSH_JOIN_PATH = "/machines/ssh-join";
/** Asks a machine for its Claude Code sign-in again, as after its Sign in terminal ends. */
export const MACHINES_CHECK_SIGN_IN_PATH = "/machines/check-sign-in";

/** Machines settings: only the local app may call them, never a paired browser or a machine. */
export const MACHINE_MANAGEMENT_PATHS: ReadonlySet<string> = new Set([
  MACHINES_LIST_PATH,
  MACHINES_JOIN_LINK_PATH,
  MACHINES_CONFIRM_PATH,
  MACHINES_REMOVE_PATH,
  MACHINES_SSH_HOSTS_PATH,
  MACHINES_SSH_JOIN_PATH,
  MACHINES_CHECK_SIGN_IN_PATH,
]);

/** What a joining machine's host reaches: answered before any browser auth, by its own rules. */
export const HOST_PATHS: ReadonlySet<string> = new Set([
  HOST_JOIN_PATH,
  HOST_CONNECT_PATH,
  HOST_INSTALL_PATH,
]);

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const refuse = (message: string, status = 403) => HttpServerResponse.text(message, { status });

const JOIN_BODY_MAX = 512;

/** A small JSON object body of at most `max` bytes, or undefined for anything else. */
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
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  });

/**
 * A request from a machine's host, not a browser: no `Origin` (every browser fetch that could
 * carry a body cross-site, and every browser WebSocket, sends one), and over the tailnet address
 * only. Forwarding headers from Tailscale Serve are expected and grant nothing.
 */
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
  /** This Gram's release, which the installer downloads; undefined when run from source. */
  appVersion?: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromAHost(request, remote)) return refuse("forbidden");
    // The installer holds no secret, and installs nothing without the join link it is given.
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
    if (request.method !== "GET") return refuse("forbidden");
    const decision = hosts.machines.authorizeConnect(remote.origin, request.headers);
    if (decision.kind === "refused") return refuse(decision.message, decision.status);
    const socket = yield* request.upgrade.pipe(Effect.option);
    if (socket._tag === "None") return refuse("WebSocket required", 400);
    yield* hosts.attach(decision.machine, socket.value, remote.origin);
    return HttpServerResponse.empty();
  });

/** What the installer prints on a machine already joined to this Gram, whose service it moves. */
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
  if (printed === undefined) return MOVED_SERVICE.test(output) ? "rejoined" : undefined;
  return machines.find(
    (machine) => !before.has(machine.id) && fingerprintOf(machine.publicKey) === printed,
  );
};

/**
 * Whether an install over SSH is running: each mints the one join link, which replaces any other,
 * so a second would spend the first's.
 */
let sshJoinRunning = false;
const SSH_JOIN_BUSY = {
  reason: "ssh-running",
  message: "Gram is adding a machine over SSH. Try again once that finishes.",
};

/** The settings page's view: the machines, and the join link waiting, if one is. */
const machinesStatus = (hosts: RemoteHostsShape) => {
  const joinLink = hosts.machines.joinOpen();
  return { machines: hosts.list(), ...(joinLink === undefined ? {} : { joinLink }) };
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
  /** This Gram's release, which the installer run over SSH downloads; undefined from source. */
  appVersion?: string,
  /** `ssh`, for tests. */
  ssh?: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST" || request.headers["origin"] === undefined)
      return refuse("forbidden");
    switch (path) {
      case MACHINES_LIST_PATH:
        return json(machinesStatus(hosts));
      case MACHINES_JOIN_LINK_PATH:
        if (remote === undefined)
          return json(
            { reason: "tailscale-off", message: "Turn on access over Tailscale first." },
            409,
          );
        // A new link would replace the one an install over SSH is using.
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
        // Built before the flag is set: it throws on what it won't embed.
        const script = installScript(remote.origin, appVersion, link.url);
        sshJoinRunning = true;
        const ran = yield* runOverSsh(target, script, ssh === undefined ? {} : { ssh }).pipe(
          Effect.exit,
          Effect.ensuring(Effect.sync(() => (sshJoinRunning = false))),
        );
        const failure =
          ran._tag === "Failure"
            ? ran.cause.reasons.find((reason) => reason._tag === "Fail")?.error
            : undefined;
        const output = ran._tag === "Success" ? ran.value : (failure?.output ?? "");
        const joined = joinedOverSsh(before, hosts.machines.list(), output);
        if (ran._tag === "Failure" && (joined === undefined || joined === "rejoined"))
          return json({ message: failure?.message ?? "The install over SSH failed.", output }, 502);
        // Run again on a machine already joined here: its service moved, and it joined before.
        if (joined === "rejoined") return json({ ...machinesStatus(hosts), joined, output });
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
        } catch {
          return json({ message: "The change couldn't be saved.", output }, 500);
        }
        // Joined with the printed key, then stopped (its service didn't start, say): it is confirmed,
        // and the person reads what went wrong.
        return json({
          ...machinesStatus(hosts),
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
      case MACHINES_CHECK_SIGN_IN_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        if (typeof id !== "string" || hosts.machines.get(id) === undefined)
          return refuse("no such machine", 404);
        yield* Effect.promise(() => hosts.checkSignIn(HostId.make(id)));
        return json(machinesStatus(hosts));
      }
      case MACHINES_CONFIRM_PATH:
      case MACHINES_REMOVE_PATH: {
        const id = (yield* jsonBody(256))?.["id"];
        if (typeof id !== "string" || hosts.machines.get(id) === undefined)
          return refuse("no such machine", 404);
        try {
          if (path === MACHINES_CONFIRM_PATH) hosts.machines.confirm(id);
          else hosts.remove(HostId.make(id));
        } catch {
          return json({ message: "The change couldn't be saved." }, 500);
        }
        return json(machinesStatus(hosts));
      }
      default:
        return refuse("forbidden");
    }
  });

/**
 * Whether the request's bearer token is a thread's whose checkout is on a joined machine that is
 * online now: what lets a session there reach its app tools over the tailnet.
 */
export const placedOnMachine = (
  tokens: Pick<McpTokens["Service"], "threadFor">,
  store: Pick<ThreadStore["Service"], "getThread"> | undefined,
  remoteHosts: Pick<RemoteHostsShape, "connection">,
  headers: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const bearer = bearerToken(headers);
    if (bearer === undefined || store === undefined) return false;
    const threadId = yield* tokens.threadFor(bearer);
    if (threadId === undefined) return false;
    const thread = yield* store.getThread(threadId).pipe(Effect.option);
    if (thread._tag === "None") return false;
    const hostId = hostOf(effectiveCheckout(thread.value));
    if (hostId === LOCAL_HOST_ID) return false;
    return (yield* remoteHosts.connection(hostId).pipe(Effect.exit))._tag === "Success";
  });
