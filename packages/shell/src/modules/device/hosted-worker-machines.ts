import type { KeyObject } from "node:crypto";

import {
  type HostedDiscovery,
  startsWorkerMachines,
  WORKER_MACHINE_CALLS,
  WORKER_MACHINE_NAME,
  type WorkerMachineCall,
  type WorkerMachineMarks,
  type WorkerMachineServer,
} from "@gram/contracts";
import { dpopProof } from "./dpop.ts";
import { hostedLogos } from "./hosted-logo.ts";
import { type FencedCall, makeWorkerMachineFence } from "./worker-machine-fence.ts";
import {
  authorizedCall,
  type Failed,
  failed,
  type HostedCalls,
  jsonOf,
  refusalOf,
  type TokenKeeper,
  UNREACHABLE,
} from "./hosted.ts";

const callAddress = (endpoint: string, which: string): string => {
  const url = new URL(endpoint);
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = `${path}/${which}`;
  return url.href;
};

/**
 * One call about a machine of a worker's own, under `worker_machines_endpoint`, with the person's
 * sign-in: its status and its JSON body as received, for this machine's server to read. The server
 * decides who the person is from the token, whether they may have the machine, and what it may be.
 */
export const callWorkerMachines = async (
  calls: HostedCalls & {
    readonly call: WorkerMachineCall;
    readonly body: Readonly<Record<string, unknown>>;
    /** Its place in the fence between a stop and a start of one name (`worker-machine-fence.ts`). */
    readonly fence?: FencedCall | undefined;
  },
): Promise<{ readonly ok: true; readonly status: number; readonly body: unknown } | Failed> => {
  const endpoint = calls.discovery.worker_machines_endpoint;
  if (endpoint === undefined || !startsWorkerMachines(calls.discovery))
    return failed("This server doesn't start machines for this computer's workers.");
  if (!(WORKER_MACHINE_CALLS as readonly string[]).includes(calls.call))
    return failed("The request isn't one the app sends.");
  const before = await calls.keeper.token("machines:workers").catch(() => undefined);
  let heldBack: string | undefined;
  const gate = calls.fence?.gate;
  const fenced: typeof calls.fetch =
    gate === undefined
      ? calls.fetch
      : async (url, init) => {
          heldBack = await gate();
          if (heldBack !== undefined) throw new Error(heldBack);
          return calls.fetch(url, init);
        };
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "machines:workers",
    fenced,
    "POST",
    callAddress(endpoint, calls.call),
    calls.body,
  );
  calls.fence?.done(!("why" in response) && response.status < 500);
  if (heldBack !== undefined) return failed(heldBack);
  if ("why" in response) return response;
  const after = await calls.keeper.token("machines:workers").catch(() => undefined);
  const secrets = [before, after].flatMap((held) =>
    held?.ok === true ? [held.token.accessToken] : [],
  );
  const body = scrubbed(await jsonOf(response), secrets);
  if (response.status === 401 || (response.status >= 500 && response.status !== 503))
    return failed(
      scrubbedOptional(refusalOf(body), secrets) ??
        (response.status === 401 ? "The server refused the sign-in." : UNREACHABLE),
    );
  return { ok: true, status: response.status, body };
};

const scrubbedOptional = (text: string | undefined, secrets: ReadonlyArray<string>) =>
  text === undefined ? undefined : scrubbedText(text, secrets);

const BASE64URL = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");

const signedToken = (word: string) => {
  const parts = word.split(".");
  return parts.length >= 3 && parts.every((part) => part.length >= 8);
};

const withoutSignedTokens = (text: string): string => {
  let out = "";
  let word = "";
  for (const char of text) {
    if (BASE64URL.has(char) || char === ".") {
      word += char;
      continue;
    }
    out += signedToken(word) ? "[redacted]" : word;
    word = "";
    out += char;
  }
  return out + (signedToken(word) ? "[redacted]" : word);
};

/** `value` with every string's copy of a secret, or of a signed token, replaced. */
export const scrubbed = (value: unknown, secrets: ReadonlyArray<string>, depth = 0): unknown => {
  if (typeof value === "string") return scrubbedText(value, secrets);
  if (typeof value !== "object" || value === null || depth > 16) return value;
  if (Array.isArray(value)) return value.map((each: unknown) => scrubbed(each, secrets, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, each]: [string, unknown]) => [
      key,
      scrubbed(each, secrets, depth + 1),
    ]),
  );
};

/** `text` with every copy of a secret, or of a signed token, replaced. */
export const scrubbedText = (text: string, secrets: ReadonlyArray<string>): string => {
  let scrubbedSoFar = text;
  for (const secret of secrets)
    if (secret !== "") scrubbedSoFar = scrubbedSoFar.split(secret).join("[redacted]");
  return withoutSignedTokens(scrubbedSoFar);
};

/**
 * The address and handshake headers of one dial of the relay that carries a worker machine's
 * connection to this machine: a fresh `machines:workers` token, bound to the device key by a proof
 * made for this dial alone.
 */
export const workerMachineRelayDial = async (
  calls: HostedCalls & { readonly name: string },
): Promise<
  { readonly ok: true; readonly url: string; readonly headers: Record<string, string> } | Failed
> => {
  const connect = calls.discovery.worker_machine_connect;
  if (connect === undefined || !startsWorkerMachines(calls.discovery))
    return failed("This server doesn't start machines for this computer's workers.");
  if (!WORKER_MACHINE_NAME.test(calls.name)) return failed("That isn't a worker machine's name.");
  const held = await calls.keeper.fresh("machines:workers");
  if (!held.ok) return failed(held.why);
  const endpoint = calls.discovery.worker_machines_endpoint;
  if (endpoint !== undefined) {
    const primed = await authorizedCall(
      calls.keeper,
      calls.key,
      "machines:workers",
      calls.fetch,
      "POST",
      callAddress(endpoint, "status"),
      { name: calls.name },
    );
    if (!("why" in primed)) await primed.body?.cancel().catch(() => undefined);
  }
  const url = new URL(connect);
  url.hash = "";
  url.searchParams.set("name", calls.name);
  const { token } = held;
  return {
    ok: true,
    url: url.href,
    headers: {
      authorization: `${token.tokenType} ${token.accessToken}`,
      dpop: dpopProof(calls.key, {
        method: "GET",
        url: url.href,
        accessToken: token.accessToken,
        now: Date.now(),
        ...(calls.keeper.nonce.value === undefined ? {} : { nonce: calls.keeper.nonce.value }),
      }),
    },
  };
};

/**
 * A live relay's lease: a `machines:workers` token never handed out before, so the server is asked
 * each time, and a sign-in it ended or revoked is found now rather than once a cached token runs
 * out. Whether one was had.
 */
export const leaseWorkerMachineRelay = async (keeper: TokenKeeper): Promise<boolean> => {
  if (keeper.signedOut()) return false;
  const held = await keeper.fresh("machines:workers").catch(() => undefined);
  return held?.ok === true;
};

const NO_WORKER_MACHINE_SERVER =
  "No hosted server this computer is signed in to starts machines for its workers.";

export const NOT_SIGNED_IN = { ok: false as const, why: "Sign in to the server first." };

/** Why a call made for one sign-in wasn't sent: the app is signed in there as someone else. */
export const ANOTHER_ACCOUNT = {
  ok: false as const,
  why: "This computer is signed in to that server as someone else now, so nothing was sent for this machine: sign in as the person it was started for.",
};

/** A device's worker-machine calls, each to the server signed in at its origin. */
export interface HostedWorkerMachines {
  /**
   * The server this computer's orchestrators may ask for machines of a worker's own: the first
   * signed in, not paused, that starts them. Or why there is none.
   */
  readonly workerMachineServer: () =>
    | { readonly ok: true; readonly server: WorkerMachineServer }
    | { readonly ok: false; readonly why: string };
  /**
   * The mark of every sign-in here whose server starts worker machines, paused or not, with the
   * marks it had before: what was made under those is moved to it, whichever sign-in spawns.
   */
  readonly workerMachineMarks: () => ReadonlyArray<WorkerMachineMarks>;
  /**
   * The mark of the server signed in at `origin` (`WorkerMachineServer.logo`), fetched once for
   * the app's run; undefined when it names none, or none the app could read.
   */
  readonly workerMachineLogo: (origin: string) => Promise<string | undefined>;
  /**
   * One call about a worker's machine, with the person's sign-in. A pause holds back a start, never
   * a status, a release or a stop, which only look or give back.
   */
  readonly workerMachineCall: (
    origin: string,
    call: WorkerMachineCall,
    body: Readonly<Record<string, unknown>>,
    sendBy?: number,
    account?: string,
  ) => Promise<
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false; readonly why: string }
  >;
  /**
   * Whether the sign-in to `origin` covers carrying its worker machines' connections now: and,
   * for a machine asked for under the sign-in `account`, whether that is the sign-in there now.
   */
  readonly workerMachineRelayAllowed: (origin: string, account?: string) => boolean;
  /**
   * A live relay's lease: whether a `machines:workers` token can still be had for `origin` now,
   * renewing it when it is due, so an expired or revoked sign-in ends the relays it covered.
   */
  readonly workerMachineRelayLease: (origin: string, account?: string) => Promise<boolean>;
  /** The address and headers of one dial of a worker machine's relay. */
  readonly workerMachineRelayDial: (
    origin: string,
    name: string,
    account?: string,
  ) => Promise<
    | { readonly ok: true; readonly url: string; readonly headers: Record<string, string> }
    | { readonly ok: false; readonly why: string }
  >;
}

interface WorkerMachineServerSide {
  readonly origin: string;
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly keeper: TokenKeeper;
  readonly machineMark: string | undefined;
  readonly formerMarks?: ReadonlyArray<string>;
  readonly limits: { readonly paused: () => boolean };
}

const ownMark = (server: WorkerMachineServerSide, account: string | undefined) =>
  account === undefined ||
  (server.machineMark !== undefined &&
    (account === server.machineMark || (server.formerMarks ?? []).includes(account)));

/** The device's worker-machine calls over the servers it is signed in to. */
export const hostedWorkerMachines = <S extends WorkerMachineServerSide>(deps: {
  readonly servers: () => Iterable<S>;
  readonly known: (origin: string) => S | undefined;
  readonly callsOf: (server: S) => HostedCalls;
}): HostedWorkerMachines => {
  const { servers, known, callsOf } = deps;
  const fence = makeWorkerMachineFence();
  const logos = hostedLogos();
  return {
    workerMachineServer: () => {
      const signedIn = [...servers()].filter(
        (server) => !server.keeper.signedOut() && startsWorkerMachines(server.discovery),
      );
      const open = signedIn.find((server) => !server.limits.paused());
      const mark = open?.machineMark;
      if (open !== undefined && mark !== undefined)
        return {
          ok: true,
          server: {
            origin: open.origin,
            server: open.discovery.name,
            account: mark,
            ...(open.formerMarks === undefined || open.formerMarks.length === 0
              ? {}
              : { formerAccounts: open.formerMarks }),
          },
        };
      if (open !== undefined)
        return {
          ok: false,
          why: "Gram is still restoring the sign-in to that server. Try again in a moment.",
        };
      if (signedIn.length > 0)
        return {
          ok: false,
          why: "You paused this computer for that server. Lift the pause under Settings → Hosted first.",
        };
      return { ok: false, why: NO_WORKER_MACHINE_SERVER };
    },

    workerMachineMarks: () =>
      [...servers()].flatMap((server) =>
        server.keeper.signedOut() ||
        !startsWorkerMachines(server.discovery) ||
        server.machineMark === undefined
          ? []
          : [
              {
                origin: server.origin,
                account: server.machineMark,
                formerAccounts: (server.formerMarks ?? []).filter(
                  (each) => each !== server.machineMark,
                ),
              },
            ],
      ),

    workerMachineLogo: async (origin) => {
      const server = known(origin);
      if (server === undefined || server.keeper.signedOut()) return undefined;
      return logos(origin, server.discovery, callsOf(server).fetch);
    },

    workerMachineCall: async (origin, call, body, sendBy, account) => {
      const server = known(origin);
      if (server === undefined || server.keeper.signedOut()) return NOT_SIGNED_IN;
      if (!ownMark(server, account)) return ANOTHER_ACCOUNT;
      if (call === "start" && server.limits.paused())
        return {
          ok: false,
          why: "You paused this computer for that server. Lift the pause under Settings → Hosted first.",
        };
      return callWorkerMachines({
        ...callsOf(server),
        call,
        body,
        fence: fence.enter(origin, call, body["name"], sendBy),
      });
    },

    workerMachineRelayAllowed: (origin, account) => {
      const server = known(origin);
      return (
        server !== undefined &&
        !server.keeper.signedOut() &&
        startsWorkerMachines(server.discovery) &&
        ownMark(server, account)
      );
    },

    workerMachineRelayLease: async (origin, account) => {
      const server = known(origin);
      if (
        server === undefined ||
        server.keeper.signedOut() ||
        !startsWorkerMachines(server.discovery) ||
        !ownMark(server, account)
      )
        return false;
      return leaseWorkerMachineRelay(server.keeper);
    },

    workerMachineRelayDial: async (origin, name, account) => {
      const server = known(origin);
      if (server === undefined || server.keeper.signedOut()) return NOT_SIGNED_IN;
      if (!ownMark(server, account)) return ANOTHER_ACCOUNT;
      return workerMachineRelayDial({ ...callsOf(server), name });
    },
  };
};
