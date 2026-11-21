import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { GatewayError, type ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** OpenRouter's consent page, which sends the person back with a code (OAuth with PKCE). */
export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
/** Where the code and its verifier become a key in the person's OpenRouter account. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";

/** How long a sign-in waits for the person to come back from OpenRouter. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The subset of `fetch` the exchange needs; injected in tests. */
export type KeyPoster = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/** A PKCE verifier: 43 unreserved characters. */
export const newVerifier = (): string => randomBytes(32).toString("base64url");

/** The S256 challenge OpenRouter checks the verifier against. */
export const challengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** The consent page for a sign-in that returns to `callbackUrl`. */
export const signInUrl = (callbackUrl: string, challenge: string): string => {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
};

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 16px">` +
  `<h1 style="font-size:20px;font-weight:600">${title}</h1><p>${text}</p></body>`;

/** A loopback listener waiting for one OpenRouter callback. */
export interface CodeListener {
  /** The address OpenRouter sends the person back to; its path is this sign-in's secret. */
  readonly callbackUrl: string;
  /** The code, once the person is back; rejects when they don't come back in time. */
  readonly code: Promise<string>;
  readonly close: () => void;
}

/**
 * Listens on `localhost` for OpenRouter to send the person back, which it allows on any port. The
 * path carries a random secret, so nothing else on the machine can hand in a code; the listener
 * takes one and closes.
 */
export const listenForCode = (timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<CodeListener> =>
  new Promise((resolveListener, rejectListener) => {
    const secret = randomBytes(18).toString("base64url");
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    code.catch(() => undefined);
    let server: Server | undefined;
    const close = () => {
      clearTimeout(timer);
      server?.close();
      server?.closeAllConnections();
      settle?.reject(new Error("The sign-in was closed."));
    };
    const timer = setTimeout(() => {
      settle?.reject(new Error("OpenRouter didn't send you back in time."));
      server?.close();
    }, timeoutMs);
    timer.unref();
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      if (request.method !== "GET" || url.pathname !== `/callback/${secret}`) {
        response.statusCode = 404;
        response.end(page("Not found", "This address is waiting for OpenRouter only."));
        return;
      }
      const received = url.searchParams.get("code");
      if (received === null || received === "") {
        response.statusCode = 400;
        response.end(
          page("Not signed in", "OpenRouter sent you back without a code. Try again from Gram."),
        );
        settle?.reject(new Error("OpenRouter sent you back without a code."));
      } else {
        response.end(
          page("Signed in to OpenRouter", "You can close this tab and go back to Gram."),
        );
        settle?.resolve(received);
      }
      clearTimeout(timer);
      server?.close();
    });
    server.once("error", rejectListener);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address === null || typeof address !== "object") {
        rejectListener(new Error("Couldn't listen for OpenRouter's callback."));
        return;
      }
      resolveListener({
        callbackUrl: `http://localhost:${address.port}/callback/${secret}`,
        code,
        close,
      });
    });
  });

/**
 * Exchanges the code for a key in the person's OpenRouter account. Errors never quote OpenRouter's
 * answer, which may echo the code.
 */
export const exchangeCode = (
  profileId: ProfileId,
  code: string,
  verifier: string,
  post: KeyPoster,
): Effect.Effect<Redacted.Redacted<string>, GatewayError> => {
  const fail = (message: string) => new GatewayError({ profileId, message });
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        post(OPENROUTER_KEYS_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
          signal,
        }),
      catch: () => fail("Couldn't reach OpenRouter to finish signing in."),
    }).pipe(
      Effect.timeoutOrElse({
        duration: 15_000,
        orElse: () => Effect.fail(fail("OpenRouter didn't answer within 15 s.")),
      }),
    );
    if (response.status === 400 || response.status === 403) {
      return yield* fail("OpenRouter refused the sign-in. Try again.");
    }
    if (!response.ok) return yield* fail(`OpenRouter answered ${response.status}.`);
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => fail("OpenRouter's answer wasn't JSON."),
    });
    const key =
      typeof body === "object" && body !== null ? (body as { key?: unknown }).key : undefined;
    if (typeof key !== "string" || key.trim() === "") {
      return yield* fail("OpenRouter's answer had no key.");
    }
    return Redacted.make(key.trim());
  });
};
