import { randomBytes, sign, type KeyObject, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  checkHostedDiscovery,
  deviceRegistrationBytes,
  HOSTED_DISCOVERY_PATH,
  type HostedDiscovery,
  HostedDeviceChallenge,
  HostedDeviceRegistered,
  hostedOrigin,
  HostedTokenAnswer,
  type HostedWorkspace,
  HostedWorkspaces,
  type DeviceId,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { dpopProof } from "./dpop.ts";
import { deviceIdOf, devicePublicKeyText } from "./keys.ts";

/**
 * The calls a desktop app makes to a hosted server it signs in to (`docs/design/personal-device.md`,
 * "The protocol"): discovery, sign-in by authorization code with PKCE through the system browser
 * and a loopback redirect, tokens kept and renewed, the workspaces list, and registering the
 * device's key. Every answer is the server's word: bounded, decoded, and never followed elsewhere.
 */

/** How long one call to the server may take. */
export const HOSTED_CALL_MS = 15_000;
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
export const HOSTED_SCOPES = ["workspaces", "device:register", "device:connect"] as const;
export type HostedScope = (typeof HOSTED_SCOPES)[number];

export type Failed = { readonly ok: false; readonly why: string };
const failed = (why: string): Failed => ({ ok: false, why });

const UNREACHABLE = "The server didn't answer.";
const UNREADABLE = "The server's answer isn't one Gram reads.";

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

const jsonOf = async (response: Response): Promise<unknown> => {
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
): Promise<Response | undefined> => {
  try {
    const deadline = AbortSignal.timeout(HOSTED_CALL_MS);
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
      },
    };
  }
  return failed("The server refused the sign-in.");
};

/** Compared in constant time, through hashes, so the lengths needn't match. */
const sameText = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const page = (response: ServerResponse, status: number, text: string) => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(text);
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
    page(response, 200, "Signed in. You can close this window and go back to Gram.");
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
      scope: HOSTED_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
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
        }
        return answer;
      }
      // Someone else's tokens can't stand in for this person's.
      if (answer.tokens.subject !== options.subject) {
        ended = true;
        tokens.clear();
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
const authorizedCall = async (
  keeper: TokenKeeper,
  key: KeyObject,
  scope: HostedScope,
  fetch: Fetch,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response | Failed> => {
  const held = await keeper.token(scope);
  if (!held.ok) return failed(held.why);
  const { token } = held;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call(fetch, url, {
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
    });
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

/**
 * Registers the device's key: the server gives a challenge for this person, the device signs it,
 * and the server answers with the id it derived from the key, which must be the device's own.
 */
export const registerHostedDevice = async (
  calls: HostedCalls & {
    readonly name: string;
    readonly platform: "darwin" | "linux" | "win32";
  },
): Promise<{ readonly ok: true; readonly deviceId: DeviceId } | Failed> => {
  const asked = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "POST",
    `${calls.discovery.devices_endpoint}/challenge`,
    {},
  );
  if ("why" in asked) return asked;
  if (asked.status !== 200) return failed("The server refused to register this machine.");
  const challenge = Schema.decodeUnknownOption(HostedDeviceChallenge)(await jsonOf(asked));
  if (challenge._tag === "None") return failed(UNREADABLE);
  const publicKey = devicePublicKeyText(calls.key);
  const signature = sign(
    null,
    deviceRegistrationBytes({
      origin: calls.discovery.issuer,
      subject: calls.keeper.subject,
      publicKey,
      challenge: challenge.value.challenge,
    }),
    calls.key,
  ).toString("base64url");
  const registered = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "POST",
    calls.discovery.devices_endpoint,
    {
      publicKey,
      challenge: challenge.value.challenge,
      signature,
      name: [...calls.name].slice(0, 128).join(""),
      platform: calls.platform,
    },
  );
  if ("why" in registered) return registered;
  if (registered.status !== 200 && registered.status !== 201)
    return failed("The server refused to register this machine.");
  const answer = Schema.decodeUnknownOption(HostedDeviceRegistered)(await jsonOf(registered));
  if (answer._tag === "None") return failed(UNREADABLE);
  // An id the server made up for another key would let it speak for a device it isn't.
  if (answer.value.deviceId !== deviceIdOf(publicKey))
    return failed("The server registered another key.");
  return { ok: true, deviceId: answer.value.deviceId };
};

/** Forgets the device on the server, as **Sign out** does. Best effort: signing out goes on. */
export const forgetHostedDevice = async (
  calls: HostedCalls & { readonly deviceId: string },
): Promise<boolean> => {
  const response = await authorizedCall(
    calls.keeper,
    calls.key,
    "device:register",
    calls.fetch,
    "DELETE",
    `${calls.discovery.devices_endpoint}/${encodeURIComponent(calls.deviceId)}`,
  );
  if ("why" in response) return false;
  await response.body?.cancel().catch(() => undefined);
  return response.status >= 200 && response.status < 300;
};
