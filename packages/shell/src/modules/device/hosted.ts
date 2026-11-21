import { randomBytes, type KeyObject, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  checkHostedDiscovery,
  HOSTED_DISCOVERY_PATH,
  type HostedDiscovery,
  hostedOrigin,
  HostedThreadImported,
  type HostedThreadExport,
  HostedThreadExported,
  type HostedThreadImport,
  type HostedThreadMessage,
  HostedThreadMessaged,
  type HostedThreadSettle,
  type HostedThreadStart,
  HostedThreadStarted,
  HostedRepositoryReach,
  HostedMachine,
  startsMachines,
  type HostedThreadStop,
  type HostedThreadWait,
  HostedThreadWaited,
  HostedTokenAnswer,
  runsSentWork,
  startsWorkerMachines,
  type HostedWorkspace,
  HostedWorkspaces,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { dpopProof } from "./dpop.ts";
import { sentDeviceName } from "./device-name.ts";
import { page, sameText } from "./hosted-loopback.ts";

/**
 * The calls a desktop app makes to a hosted server it signs in to (`docs/design/personal-device.md`,
 * "The protocol"): discovery, sign-in by authorization code with PKCE through the system browser
 * and a loopback redirect, tokens kept and renewed, the workspaces list, and registering the
 * device's key. Every answer is the server's word: bounded, decoded, and never followed elsewhere.
 */

/** How long one call to the server may take. */
export const HOSTED_CALL_MS = 15_000;
/**
 * A thread brought in is cloned on the person's machine there before the server answers. A call
 * the server asks to repeat for a nonce gets it again, so the whole may take twice as long.
 */
export const HOSTED_THREAD_IMPORT_MS = 100_000;
/** How long the person has to finish signing in, in the browser. */
export const HOSTED_SIGN_IN_MS = 5 * 60_000;
/** The most an answer may hold. */
export const HOSTED_ANSWER_MOST_BYTES = 256 * 1024;
/** The longest an access token is used, whatever the server says: the design's fifteen minutes. */
export const HOSTED_TOKEN_MOST_MS = 15 * 60_000;
/** How long the keychain may take to keep a refresh token. */
export const HOSTED_SAVE_MS = 10_000;
/** A token this close to its end is renewed before it is used. */
export const HOSTED_TOKEN_RENEW_BEFORE_MS = 60_000;

/** The scopes a device signs in for. Each use gets a token of its own, narrowed from these. */
export const HOSTED_SCOPES = [
  "workspaces",
  "device:register",
  "device:connect",
  "workspaces:import",
  "workspaces:export",
  "threads:start",
  "models",
  "machines:workers",
] as const;
export type HostedScope = (typeof HOSTED_SCOPES)[number];

export type Failed = { readonly ok: false; readonly why: string };
export const failed = (why: string): Failed => ({ ok: false, why });

export const UNREACHABLE = "The server didn't answer.";
export const UNREADABLE = "The server's answer isn't one Gram reads.";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Reads an answer's body, no more than `most` bytes; undefined when it is longer. */
const readBounded = async (response: Response, most: number): Promise<string | undefined> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const parts: Array<Uint8Array> = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > most) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      parts.push(value);
    }
  } catch {
    // The body broke off, or the call's deadline passed partway through it.
    return undefined;
  }
  return Buffer.concat(parts).toString("utf8");
};

export const jsonOf = async (response: Response): Promise<unknown> => {
  const text = await readBounded(response, HOSTED_ANSWER_MOST_BYTES);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** One call: no redirects followed, a deadline, and a refusal rather than a throw. */
const call = async (
  fetch: Fetch,
  url: string,
  init: RequestInit,
  waitMs = HOSTED_CALL_MS,
): Promise<Response | undefined> => {
  try {
    const deadline = AbortSignal.timeout(waitMs);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal == null ? deadline : AbortSignal.any([init.signal, deadline]),
    });
    return response;
  } catch {
    return undefined;
  }
};

export type Discovered =
  | { readonly ok: true; readonly origin: string; readonly discovery: HostedDiscovery }
  | Failed;

/** Finds the server at the address the person typed, and checks what it says about itself. */
export const discoverHosted = async (typed: string, fetch: Fetch): Promise<Discovered> => {
  const origin = hostedOrigin(typed);
  if (origin === undefined) return failed("That isn't an address Gram uses.");
  const response = await call(fetch, `${origin}${HOSTED_DISCOVERY_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (response === undefined) return failed(UNREACHABLE);
  if (response.status !== 200) return failed("There's no hosted Gram at that address.");
  const checked = checkHostedDiscovery(origin, await jsonOf(response));
  return checked.ok ? { ok: true, origin, discovery: checked.discovery } : checked;
};

/** A token as it is used: what to send, what kind, until when, and for whom. */
export interface HostedToken {
  readonly accessToken: string;
  /** Always bound to the device key: a proof goes with every use. */
  readonly tokenType: "DPoP";
  /** By the caller's clock. */
  readonly expiresAt: number;
  readonly subject: string;
}

export interface HostedTokens extends HostedToken {
  readonly refreshToken?: string;
  /** The organisation the grant is for, where the server says (`HostedTokenAnswer`). */
  readonly organization?: string;
  readonly grantedScopes?: readonly string[];
}

interface TokenCallOptions {
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly fetch: Fetch;
  readonly now: () => number;
  /** The server's last `DPoP-Nonce`, kept between calls. */
  readonly nonce: { value?: string };
  /** Ends the call early. */
  readonly signal?: AbortSignal;
}
// `now` above is a clock that only goes forward, for when a token ends.

const nonceFrom = (response: Response): string | undefined => {
  const nonce = response.headers.get("dpop-nonce");
  return nonce !== null && /^[\x21-\x7e]{1,256}$/.test(nonce) ? nonce : undefined;
};

/**
 * A call to the token endpoint, with a proof of the device key, once more if the server asks
 * for a nonce first.
 */
const tokenCall = async (
  options: TokenCallOptions,
  form: Record<string, string>,
): Promise<{ ok: true; tokens: HostedTokens } | (Failed & { readonly signedOut?: true })> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call(options.fetch, options.discovery.token_endpoint, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        dpop: dpopProof(options.key, {
          method: "POST",
          url: options.discovery.token_endpoint,
          // A proof's time is the wall clock's, as the server reads it.
          now: Date.now(),
          ...(options.nonce.value === undefined ? {} : { nonce: options.nonce.value }),
        }),
      },
      body: new URLSearchParams({ client_id: options.discovery.client_id, ...form }).toString(),
    });
    if (response === undefined) return failed(UNREACHABLE);
    const nonce = nonceFrom(response);
    if (nonce !== undefined) options.nonce.value = nonce;
    const answer = await jsonOf(response);
    if (response.status !== 200) {
      const error =
        typeof answer === "object" && answer !== null && "error" in answer ? answer.error : "";
      if (error === "use_dpop_nonce" && nonce !== undefined && attempt === 0) continue;
      if (error === "invalid_grant")
        return { ...failed("The sign-in has ended."), signedOut: true };
      // A scope the sign-in never had, or the organisation turned off since.
      if (error === "invalid_scope")
        return failed("Your sign-in there doesn't cover this. Sign in to the server again.");
      return failed("The server refused the sign-in.");
    }
    const decoded = Schema.decodeUnknownOption(HostedTokenAnswer)(answer);
    if (decoded._tag === "None") return failed(UNREADABLE);
    const token = decoded.value;
    // Every token a device holds is bound to its key, so a copy is no use without the key.
    if (token.token_type.toLowerCase() !== "dpop")
      return failed("The server didn't bind the sign-in to this machine.");
    const lasts = Math.min(Math.max(0, Math.floor(token.expires_in)) * 1000, HOSTED_TOKEN_MOST_MS);
    if (lasts <= HOSTED_TOKEN_RENEW_BEFORE_MS) return failed(UNREADABLE);
    return {
      ok: true,
      tokens: {
        accessToken: token.access_token,
        tokenType: "DPoP",
        expiresAt: options.now() + lasts,
        subject: token.sub,
        ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
        ...(token.organization === undefined ? {} : { organization: token.organization }),
        ...(token.scope === undefined ? {} : { grantedScopes: token.scope.trim().split(/ +/) }),
      },
    };
  }
  return failed("The server refused the sign-in.");
};

export interface SignInOptions {
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  /** Opens the address in the system browser. */
  readonly openBrowser: (url: string) => Promise<void>;
  readonly fetch: Fetch;
  readonly now: () => number;
  /** Ends the sign-in early, as when the person closes the dialog. */
  readonly signal?: AbortSignal;
  readonly waitMs?: number;
  /** This computer's name, offered to the sign-in page as `device_name` (`device-name.ts`). */
  readonly deviceName?: string;
}

export type SignedIn = { readonly ok: true; readonly tokens: HostedTokens } | Failed;

/**
 * Signs in through the system browser: an authorization code with PKCE (`S256`), returned to a
 * loopback address on a random port, with its `state` and `iss` checked, then exchanged with a
 * proof of the device key. Gives a refresh token for every scope the device uses.
 */
export const signInHosted = async (options: SignInOptions): Promise<SignedIn> => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const { discovery } = options;
  const deviceName = sentDeviceName(options.deviceName);

  const { promise: answered, resolve: finish } = Promise.withResolvers<{ code: string } | Failed>();
  let expectedHost = "";
  const answerCallback = (request: IncomingMessage, response: ServerResponse) => {
    const target = request.url ?? "";
    if (
      request.method !== "GET" ||
      !target.startsWith("/callback?") ||
      request.headers.host !== expectedHost
    ) {
      page(response, 404, "Not found.");
      return;
    }
    const url = new URL(target, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      page(response, 404, "Not found.");
      return;
    }
    const given = url.searchParams.get("state") ?? "";
    // Another page on this machine can find the port; without the state it ends nothing.
    if (!sameText(given, state)) {
      page(response, 400, "This sign-in isn't Gram's.");
      return;
    }
    const issuer = url.searchParams.get("iss");
    if (issuer !== discovery.issuer) {
      page(response, 400, "The sign-in came back from another server.");
      finish(failed("The sign-in came back from another server."));
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || !/^[\x21-\x7e]{1,2048}$/.test(code)) {
      page(response, 400, "The sign-in didn't finish.");
      finish(failed("The sign-in didn't finish."));
      return;
    }
    page(response, 200, "The browser step finished. Return to Gram to check the connection.");
    finish({ code });
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    try {
      answerCallback(request, response);
    } catch {
      // Whatever another program on this machine sends, it ends nothing and throws nothing.
      if (!response.headersSent) page(response, 400, "Not a sign-in.");
      else response.destroy();
    }
  });
  const listening = new Promise<number | undefined>((done) => {
    server.once("error", () => done(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done(typeof address === "object" && address !== null ? address.port : undefined);
    });
  });
  const timer = setTimeout(
    () => finish(failed("The sign-in took too long.")),
    options.waitMs ?? HOSTED_SIGN_IN_MS,
  );
  const onAbort = () => finish(failed("The sign-in was stopped."));
  const stopped = () => options.signal?.aborted === true;
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const port = await listening;
    if (port === undefined) return failed("Gram couldn't wait for the browser.");
    expectedHost = `127.0.0.1:${port}`;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: discovery.client_id,
      redirect_uri: redirectUri,
      // Moving work is asked for only of a server that takes it: another may refuse the scope.
      scope: HOSTED_SCOPES.filter(
        (scope) =>
          (scope !== "workspaces:import" || discovery.thread_import_endpoint !== undefined) &&
          (scope !== "workspaces:export" || givesThreads(discovery)) &&
          (scope !== "threads:start" || runsSentWork(discovery)) &&
          (scope !== "models" || discovery.models_endpoint !== undefined) &&
          (scope !== "machines:workers" || startsWorkerMachines(discovery)),
      ).join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(deviceName === undefined ? {} : { device_name: deviceName }),
    }).toString();
    if (stopped()) return failed("The sign-in was stopped.");
    // Not waited for: a browser that never says it opened still can't hold the sign-in open.
    void Promise.resolve()
      .then(() => options.openBrowser(authorize.href))
      .catch(() => {
        finish(failed("Gram couldn't open the browser."));
      });
    const answer = await answered;
    if (!("code" in answer)) return answer;
    if (stopped()) return failed("The sign-in was stopped.");
    const exchanged = await tokenCall(
      {
        discovery,
        key: options.key,
        fetch: options.fetch,
        now: options.now,
        nonce: {},
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        grant_type: "authorization_code",
        code: answer.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    );
    if (stopped()) return failed("The sign-in was stopped.");
    if (!exchanged.ok) return failed(exchanged.why);
    if (exchanged.tokens.refreshToken === undefined) return failed(UNREADABLE);
    return exchanged;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.closeAllConnections();
    server.close();
  }
};

export interface TokenKeeperOptions {
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly subject: string;
  readonly refreshToken: string;
  /** Keeps a rotated refresh token, in the keychain, before it is used. */
  readonly saveRefreshToken: (token: string) => Promise<void>;
  /** How long the keychain is waited for; the write goes on, and a newer one follows it. */
  readonly saveWaitMs?: number;
  readonly fetch: Fetch;
  /** A clock that only goes forward, in milliseconds. */
  readonly now: () => number;
  /** The server ended the sign-in, or answered for someone else: it is over. */
  readonly ended?: () => void;
  /**
   * Each renewal's answer as it is taken, for whom and which organisation it is: awaited before
   * its token is handed out, so what it keeps is kept before anything is asked with the token.
   */
  readonly renewed?: (tokens: HostedTokens) => void | Promise<void>;
}

export type TokenFor =
  | { readonly ok: true; readonly token: HostedToken }
  | (Failed & { readonly signedOut?: true });

const signedOutNow = (): TokenFor => ({ ...failed("Signed out."), signedOut: true });

export interface TokenKeeper {
  /** The person this sign-in is for: their subject id, as the server issued it. */
  readonly subject: string;
  /** A token for one use, renewed when it is near its end. */
  readonly token: (scope: HostedScope) => Promise<TokenFor>;
  /** A token for one use, never one handed out before: for a dial, and `device.token`. */
  readonly fresh: (scope: HostedScope) => Promise<TokenFor>;
  /** The server's last `DPoP-Nonce`, shared with calls made with the tokens. */
  readonly nonce: { value?: string };
  /** Signed out: the server said the refresh token is no good, or the person signed out. */
  readonly signedOut: () => boolean;
  /**
   * Ends the sign-in. Settles once nothing under way can still write a refresh token, so the
   * keychain is cleared after it.
   */
  readonly signOut: () => Promise<void>;
  /** The keychain didn't take the latest refresh token; it is tried again at each renewal. */
  readonly unsaved: () => boolean;
}

/**
 * Keeps one person's sign-in to one server: the refresh token, rotated as the server gives a new
 * one, and a token per scope. Renewals go one at a time, since each may rotate the refresh token.
 */
export const makeTokenKeeper = (options: TokenKeeperOptions): TokenKeeper => {
  let refreshToken = options.refreshToken;
  let ended = false;
  const tokens = new Map<HostedScope, HostedToken>();
  const nonce: { value?: string } = {};
  /** The token endpoint's own nonce: a server may give its calls and its tokens different ones. */
  const tokenNonce: { value?: string } = {};
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<HostedScope, Promise<TokenFor>>();
  /**
   * Which refresh token the keychain holds. Each rotation is a new generation, and writes go one
   * at a time, newest last, so a write the keychain was slow with never lands over a newer one.
   */
  let generation = 0;
  let savedGeneration = 0;
  let saving: Promise<void> | undefined;
  const saveWaitMs = options.saveWaitMs ?? HOSTED_SAVE_MS;
  const signedOutYet = () => ended;

  const writeLatest = (): Promise<void> => {
    saving ??= (async () => {
      while (!signedOutYet() && savedGeneration < generation) {
        const writing = generation;
        try {
          await options.saveRefreshToken(refreshToken);
        } catch {
          return;
        }
        savedGeneration = writing;
      }
    })().finally(() => {
      saving = undefined;
    });
    return saving;
  };

  /** Saves the newest refresh token, waiting no longer than the keychain is given. */
  const save = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      writeLatest(),
      new Promise<void>((done) => {
        timer = setTimeout(done, saveWaitMs);
      }),
    ]);
    clearTimeout(timer);
  };

  const renew = (scope: HostedScope, keep: boolean): Promise<TokenFor> => {
    const next = queue.then(async (): Promise<TokenFor> => {
      if (ended) return signedOutNow();
      if (savedGeneration < generation) await save();
      if (ended) return signedOutNow();
      const answer = await tokenCall(
        {
          discovery: options.discovery,
          key: options.key,
          fetch: options.fetch,
          now: options.now,
          nonce: tokenNonce,
        },
        { grant_type: "refresh_token", refresh_token: refreshToken, scope },
      );
      // Signed out while it was asked: nothing it brought back is kept.
      if (ended) return signedOutNow();
      if (!answer.ok) {
        if (answer.signedOut === true) {
          ended = true;
          tokens.clear();
          options.ended?.();
        }
        return answer;
      }
      // Someone else's tokens can't stand in for this person's.
      if (answer.tokens.subject !== options.subject) {
        ended = true;
        tokens.clear();
        options.ended?.();
        return { ...failed("The server signed in someone else."), signedOut: true };
      }
      if (answer.tokens.refreshToken !== undefined && answer.tokens.refreshToken !== refreshToken) {
        // The server has let the old one go: this one is used from now on, saved or not, and
        // saved again before the next renewal if the keychain didn't take it.
        refreshToken = answer.tokens.refreshToken;
        generation += 1;
        await save();
        if (ended) return signedOutNow();
      }
      await options.renewed?.(answer.tokens);
      if (ended) return signedOutNow();
      const { refreshToken: _rotated, ...token } = answer.tokens;
      // A fresh token is for one use alone, so it is never handed out again.
      if (keep) tokens.set(scope, token);
      return { ok: true, token };
    });
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    subject: options.subject,
    token: async (scope) => {
      const held = tokens.get(scope);
      if (
        !ended &&
        held !== undefined &&
        held.expiresAt - HOSTED_TOKEN_RENEW_BEFORE_MS > options.now()
      )
        return { ok: true, token: held };
      // Callers that find the same token near its end share one renewal.
      const waiting = pending.get(scope);
      if (waiting !== undefined) return waiting;
      const renewal = renew(scope, true).finally(() => pending.delete(scope));
      pending.set(scope, renewal);
      return renewal;
    },
    fresh: (scope) => renew(scope, false),
    nonce,
    signedOut: () => ended,
    unsaved: () => savedGeneration < generation,
    signOut: async () => {
      ended = true;
      tokens.clear();
      // Whatever was asked or written before is over before the caller clears the keychain.
      await queue;
      await saving;
    },
  };
};

/** A call made with a token: its proof when it is bound to the key, once more for a nonce. */
export const authorizedCall = async (
  keeper: TokenKeeper,
  key: KeyObject,
  scope: HostedScope,
  fetch: Fetch,
  method: string,
  url: string,
  body?: unknown,
  waitMs?: number,
): Promise<Response | Failed> => {
  const held = await keeper.token(scope);
  if (!held.ok) return failed(held.why);
  const { token } = held;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call(
      fetch,
      url,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `${token.tokenType} ${token.accessToken}`,
          ...(token.tokenType === "DPoP"
            ? {
                dpop: dpopProof(key, {
                  method,
                  url,
                  accessToken: token.accessToken,
                  now: Date.now(),
                  ...(keeper.nonce.value === undefined ? {} : { nonce: keeper.nonce.value }),
                }),
              }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      waitMs,
    );
    if (response === undefined) return failed(UNREACHABLE);
    const nonce = nonceFrom(response);
    if (nonce !== undefined) keeper.nonce.value = nonce;
    if (
      response.status === 401 &&
      nonce !== undefined &&
      attempt === 0 &&
      /error="use_dpop_nonce"/.test(response.headers.get("www-authenticate") ?? "")
    ) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    return response;
  }
  return failed("The server refused the call.");
};

export interface HostedCalls {
  readonly discovery: HostedDiscovery;
  readonly keeper: TokenKeeper;
  readonly key: KeyObject;
  readonly fetch: Fetch;
}

/** The person's workspaces on the server, as it lists them. */
export const listHostedWorkspaces = async (
  calls: HostedCalls,
): Promise<{ readonly ok: true; readonly workspaces: ReadonlyArray<HostedWorkspace> } | Failed> => {
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "workspaces",
    calls.fetch,
    "GET",
    calls.discovery.workspaces_endpoint,
  );
  if ("why" in response) return response;
  if (response.status !== 200) return failed("The server refused the call.");
  const decoded = Schema.decodeUnknownOption(HostedWorkspaces)(await jsonOf(response));
  return decoded._tag === "None" ? failed(UNREADABLE) : { ok: true, workspaces: decoded.value };
};

/** A refusal's own words, as `{ error: { message } }` or `{ error }` puts them; bounded. */
export const refusalOf = (answer: unknown): string | undefined => {
  if (typeof answer !== "object" || answer === null || !("error" in answer)) return undefined;
  const { error } = answer;
  const said =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? error.message
        : undefined;
  if (typeof said !== "string" || said.trim() === "") return undefined;
  return [...said.trim()].slice(0, 300).join("");
};

/** How a thread's send ended. `unknown`: no clear answer, so the server may have taken it. */
export type HostedThreadSent =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly notes: readonly string[];
      readonly url?: string;
    }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

/**
 * Sends a thread this machine exported to a workspace there, with the person's sign-in, and
 * reads what the server made of it. The server decides whether it comes in; a refusal is its word.
 */
export const importHostedThread = async (
  calls: HostedCalls & HostedThreadImport,
): Promise<HostedThreadSent> => {
  const endpoint = calls.discovery.thread_import_endpoint;
  if (endpoint === undefined) return failed("This server doesn't take threads.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "workspaces:import",
    calls.fetch,
    "POST",
    endpoint,
    { workspaceId: calls.workspaceId, bundle: calls.bundle, from: calls.from },
    HOSTED_THREAD_IMPORT_MS,
  );
  if ("why" in response) {
    // No answer may be one that never came back: the server may have the thread.
    return response.why === UNREACHABLE ? { ...response, unknown: true } : response;
  }
  if (response.status === 413) {
    await response.body?.cancel().catch(() => undefined);
    return failed("The thread is larger than the server takes.");
  }
  const answer = await jsonOf(response);
  // A server fault, or a yes it can't read, may still have made the thread there.
  if (response.status >= 500) return { ...failed(refusalOf(answer) ?? UNREACHABLE), unknown: true };
  if (response.status !== 200) return failed(refusalOf(answer) ?? "The server refused the thread.");
  const decoded = Schema.decodeUnknownOption(HostedThreadImported)(answer);
  if (decoded._tag === "None") return { ...failed(UNREADABLE), unknown: true };
  const { threadId, notes = [], url } = decoded.value;
  // Opened only where the server is: never an address it sends elsewhere.
  const opens = url !== undefined && sameOrigin(url, calls.discovery.issuer) ? url : undefined;
  return { ok: true, threadId, notes, ...(opens === undefined ? {} : { url: opens }) };
};

/** Whether the server gives threads that moved there back: it names both calls for it. */
export const givesThreads = (discovery: HostedDiscovery): boolean =>
  discovery.thread_export_endpoint !== undefined && discovery.thread_settle_endpoint !== undefined;

/** The longest bundle read back from a server: a long conversation, its edits being at the remote. */
export const HOSTED_THREAD_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Asks the server for a thread of a workspace there as a bundle, with the person's sign-in, to
 * bring it back here. The server decides whether it may go; a refusal is its word. Nothing changes
 * there but the ref its edits are kept on, so a call with no answer can simply be made again.
 */
export const exportHostedThread = async (
  calls: HostedCalls & HostedThreadExport,
): Promise<{ readonly ok: true; readonly bundle: unknown } | Failed> => {
  const endpoint = calls.discovery.thread_export_endpoint;
  if (endpoint === undefined || !givesThreads(calls.discovery))
    return failed("This server doesn't give threads back.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "workspaces:export",
    calls.fetch,
    "POST",
    endpoint,
    { workspaceId: calls.workspaceId, threadId: calls.threadId },
    HOSTED_THREAD_IMPORT_MS,
  );
  if ("why" in response) return response;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > HOSTED_THREAD_EXPORT_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return failed("The thread is larger than Gram takes back.");
  }
  const answer = await jsonOf(response);
  if (response.status !== 200)
    return failed(refusalOf(answer) ?? "The server refused to give the thread back.");
  const decoded = Schema.decodeUnknownOption(HostedThreadExported)(answer);
  return decoded._tag === "None" ? failed(UNREADABLE) : { ok: true, bundle: decoded.value.bundle };
};

/**
 * Tells the server the thread is here now, so its copy there becomes read-only. `unknown` when
 * there was no clear answer: settling again is safe, since a settled copy stays settled.
 */
export const settleHostedThread = async (
  calls: HostedCalls & HostedThreadSettle,
): Promise<{ readonly ok: true } | (Failed & { readonly unknown?: true })> => {
  const endpoint = calls.discovery.thread_settle_endpoint;
  if (endpoint === undefined || !givesThreads(calls.discovery))
    return failed("This server doesn't give threads back.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "workspaces:export",
    calls.fetch,
    "POST",
    endpoint,
    {
      workspaceId: calls.workspaceId,
      threadId: calls.threadId,
      exportedAt: calls.exportedAt,
      to: calls.to,
    },
  );
  if ("why" in response)
    return response.why === UNREACHABLE ? { ...response, unknown: true } : response;
  const answer = await jsonOf(response);
  if (response.status >= 500) return { ...failed(refusalOf(answer) ?? UNREACHABLE), unknown: true };
  if (response.status !== 200)
    return failed(refusalOf(answer) ?? "The server refused to settle the thread there.");
  return { ok: true };
};

/** The longest a wait there is asked to last: the server's own bound. */
export const HOSTED_WAIT_MOST_SECONDS = 20;

/** How a send of work ended. `unknown`: no clear answer, so sending again with its key is safe. */
export type HostedWorkSent =
  | { readonly ok: true; readonly threadId: string; readonly branch?: string }
  | (Failed & { readonly unknown?: true });

/**
 * Sends work from this machine to run there, as a new thread of one of the person's workspaces,
 * with their sign-in. The server decides whether it runs; a refusal is its word. The key makes a
 * second send the same send, so one with no answer can be made again.
 */
export const startHostedThread = async (
  calls: HostedCalls & HostedThreadStart,
): Promise<HostedWorkSent> => {
  const endpoint = calls.discovery.thread_start_endpoint;
  if (endpoint === undefined || !runsSentWork(calls.discovery))
    return failed("This server doesn't run work sent to it.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    {
      workspaceId: calls.workspaceId,
      repositories: calls.repositories,
      text: calls.text,
      ...(calls.title === undefined ? {} : { title: calls.title }),
      ...(calls.branch === undefined ? {} : { branch: calls.branch }),
      clientKey: calls.clientKey,
    },
    HOSTED_THREAD_IMPORT_MS,
  );
  if ("why" in response)
    return response.why === UNREACHABLE ? { ...response, unknown: true } : response;
  const answer = await jsonOf(response);
  if (response.status >= 500) return { ...failed(refusalOf(answer) ?? UNREACHABLE), unknown: true };
  if (response.status !== 200) return failed(refusalOf(answer) ?? "The server refused the work.");
  const decoded = Schema.decodeUnknownOption(HostedThreadStarted)(answer);
  if (decoded._tag === "None") return { ...failed(UNREADABLE), unknown: true };
  const { threadId, branch } = decoded.value;
  return { ok: true, threadId, ...(branch === undefined ? {} : { branch }) };
};

/**
 * Asks, before work is sent, whether a thread there could clone each repository and push its
 * branch, with the person's sign-in. Changes nothing there. A server that doesn't answer it says
 * nothing either way: the send is still the server's to refuse.
 */
export const checkHostedRepositories = async (
  calls: HostedCalls & {
    readonly workspaceId: string;
    readonly repositories: readonly string[];
  },
): Promise<{ readonly ok: true; readonly reach: HostedRepositoryReach } | Failed> => {
  const endpoint = calls.discovery.thread_check_endpoint;
  if (endpoint === undefined || !runsSentWork(calls.discovery))
    return failed("This server doesn't check repositories before work is sent.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    { workspaceId: calls.workspaceId, repositories: calls.repositories },
  );
  if ("why" in response) return response;
  const answer = await jsonOf(response);
  if (response.status !== 200)
    return failed(refusalOf(answer) ?? "The server didn't check the repositories.");
  const decoded = Schema.decodeUnknownOption(HostedRepositoryReach)(answer);
  if (decoded._tag === "None") return failed(UNREADABLE);
  return { ok: true, reach: decoded.value };
};

/**
 * Reads the person's own machine in a workspace there (`get`), or starts it unless it runs
 * (`start`), with their sign-in, for work sent with none running. The server decides whether it
 * may start and on what, within the organisation's limits; a refusal is its word. A start that
 * runs already changes nothing, so one with no answer can be made again. `unoffered`: the server
 * starts no machine from here, and the send is left to say so.
 */
export const hostedMachine = async (
  calls: HostedCalls & { readonly workspaceId: string; readonly action: "get" | "start" },
): Promise<{ readonly ok: true; readonly machine: HostedMachine | "unoffered" } | Failed> => {
  if (!startsMachines(calls.discovery) || !runsSentWork(calls.discovery))
    return { ok: true, machine: "unoffered" };
  const endpoint =
    calls.action === "start"
      ? calls.discovery.machine_start_endpoint
      : calls.discovery.machine_status_endpoint;
  if (endpoint === undefined) return { ok: true, machine: "unoffered" };
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    { workspaceId: calls.workspaceId },
  );
  if ("why" in response) return response;
  const answer = await jsonOf(response);
  if (response.status !== 200)
    return failed(
      refusalOf(answer) ??
        (calls.action === "start"
          ? "The server didn't start your machine."
          : "The server didn't say how your machine stands."),
    );
  const decoded = Schema.decodeUnknownOption(HostedMachine)(answer);
  if (decoded._tag === "None") return failed(UNREADABLE);
  return {
    ok: true,
    machine: {
      phase: decoded.value.phase,
      ...(decoded.value.starting === undefined ? {} : { starting: decoded.value.starting }),
    },
  };
};

/**
 * Waits on a thread sent from here, as the server lets it be followed: a reply, its turn ending,
 * it waiting on a person there. Changes nothing, so a wait with no answer is simply waited again.
 */
export const waitHostedThread = async (
  calls: HostedCalls & HostedThreadWait,
): Promise<{ readonly ok: true; readonly waited: HostedThreadWaited } | Failed> => {
  const endpoint = calls.discovery.thread_wait_endpoint;
  if (endpoint === undefined || !runsSentWork(calls.discovery))
    return failed("This server doesn't run work sent to it.");
  const seconds = Math.max(
    1,
    Math.min(
      HOSTED_WAIT_MOST_SECONDS,
      Math.floor(calls.timeoutSeconds ?? HOSTED_WAIT_MOST_SECONDS),
    ),
  );
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    {
      workspaceId: calls.workspaceId,
      threadId: calls.threadId,
      ...(calls.after === undefined ? {} : { after: calls.after }),
      ...(calls.until === undefined ? {} : { until: calls.until }),
      timeoutSeconds: seconds,
    },
    // The wait itself, and a call's time beside it.
    seconds * 1000 + HOSTED_CALL_MS,
  );
  if ("why" in response) return response;
  const answer = await jsonOf(response);
  if (response.status !== 200) return failed(refusalOf(answer) ?? "The server refused the call.");
  const decoded = Schema.decodeUnknownOption(HostedThreadWaited)(answer);
  return decoded._tag === "None" ? failed(UNREADABLE) : { ok: true, waited: decoded.value };
};

/**
 * A message into a thread sent from here, as the person typed it. `unknown` when there was no
 * clear answer: sending again with the same key delivers it once.
 */
export const messageHostedThread = async (
  calls: HostedCalls & HostedThreadMessage,
): Promise<
  | { readonly ok: true; readonly queued: boolean; readonly after?: string }
  | (Failed & { readonly unknown?: true })
> => {
  const endpoint = calls.discovery.thread_message_endpoint;
  if (endpoint === undefined || !runsSentWork(calls.discovery))
    return failed("This server doesn't run work sent to it.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    {
      workspaceId: calls.workspaceId,
      threadId: calls.threadId,
      text: calls.text,
      ...(calls.mode === undefined ? {} : { mode: calls.mode }),
      clientKey: calls.clientKey,
    },
  );
  if ("why" in response)
    return response.why === UNREACHABLE ? { ...response, unknown: true } : response;
  const answer = await jsonOf(response);
  if (response.status >= 500) return { ...failed(refusalOf(answer) ?? UNREACHABLE), unknown: true };
  if (response.status !== 200)
    return failed(refusalOf(answer) ?? "The server refused the message.");
  const decoded = Schema.decodeUnknownOption(HostedThreadMessaged)(answer);
  if (decoded._tag === "None") return { ...failed(UNREADABLE), unknown: true };
  const { queued = false, after } = decoded.value;
  return { ok: true, queued, ...(after === undefined ? {} : { after }) };
};

/** Stops the turn a thread sent from here is working on. Stopping again is safe. */
export const stopHostedThread = async (
  calls: HostedCalls & HostedThreadStop,
): Promise<{ readonly ok: true } | Failed> => {
  const endpoint = calls.discovery.thread_stop_endpoint;
  if (endpoint === undefined || !runsSentWork(calls.discovery))
    return failed("This server doesn't run work sent to it.");
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "threads:start",
    calls.fetch,
    "POST",
    endpoint,
    { workspaceId: calls.workspaceId, threadId: calls.threadId },
  );
  if ("why" in response) return response;
  const answer = await jsonOf(response);
  if (response.status !== 200)
    return failed(refusalOf(answer) ?? "The server refused to stop the thread.");
  return { ok: true };
};

const sameOrigin = (address: string, origin: string): boolean => {
  try {
    const url = new URL(address);
    return (
      url.origin === origin &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};
