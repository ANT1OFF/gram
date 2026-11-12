// What an embedding deployment hands the server at start: a server run behind another service
// (self-hosted for a team, or as one part of a larger product) rather than as the desktop app's
// own. All of it comes from the environment, none of it is a setting, and none of it does anything
// until the hosted features setting (`experimental.embedding`) is on.

/** The least a token may be: shorter is refused at start rather than trusted. */
export const EMBED_TOKEN_MIN = 32;

/** One outside service the server calls: where it is, and the bearer token it is sent, if any. */
export interface OutsideService {
  readonly url: string;
  readonly token?: string;
}

export interface EmbedConfigShape {
  /**
   * The bearer token the embedding platform's own services send on `/embed/v1/*`
   * (`GRAM_EMBED_TOKEN`). Absent, those paths don't exist.
   */
  readonly inboundToken?: string;
  /**
   * `pushed`: pull request, check and review events arrive on `/embed/v1/repo-events`, so the
   * background sweeps stop asking GitHub about them (`GRAM_REPO_EVENTS=pushed`).
   */
  readonly repoEvents: "poll" | "pushed";
  /**
   * Where wakes and routine timers are registered, to be fired from there (`GRAM_SCHEDULER_URL`,
   * `GRAM_SCHEDULER_TOKEN`).
   */
  readonly scheduler?: OutsideService;
  /**
   * Where attachments, docs and outputs are kept (`GRAM_OBJECT_STORE_URL`,
   * `GRAM_OBJECT_STORE_TOKEN`).
   */
  readonly objectStore?: OutsideService;
  /**
   * Where a person's machine is asked for, for a headless server whose deployment provisions hosts
   * on demand (`GRAM_HOST_PROVIDER_URL`, `GRAM_HOST_PROVIDER_TOKEN`; see `on-demand.ts`).
   */
  readonly hostProvider?: OutsideService;
}

export const NO_EMBED: EmbedConfigShape = { repoEvents: "poll" };

/** An `http:` or `https:` URL with no credentials, query or fragment, without its trailing slash. */
const serviceUrl = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    // Never echoed: a URL pasted with a credential in it must not reach a log.
    throw new Error(`${name} must be an http(s) URL with no credentials, query or fragment`);
  }
  return url.href.replace(/\/+$/, "");
};

const tokenOf = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value.length < EMBED_TOKEN_MIN || /\s/.test(value)) {
    throw new Error(`${name} must be at least ${EMBED_TOKEN_MIN} characters with no whitespace`);
  }
  return value;
};

const service = (
  env: Record<string, string | undefined>,
  prefix: string,
): OutsideService | undefined => {
  const url = serviceUrl(`${prefix}_URL`, env[`${prefix}_URL`]);
  const token = tokenOf(`${prefix}_TOKEN`, env[`${prefix}_TOKEN`]);
  if (url === undefined) {
    if (token !== undefined) throw new Error(`${prefix}_TOKEN is set without ${prefix}_URL`);
    return undefined;
  }
  return { url, ...(token === undefined ? {} : { token }) };
};

/** The variables that carry a secret, which nothing the server starts may inherit. */
const SECRET_VARIABLES = [
  "GRAM_EMBED_TOKEN",
  "GRAM_SCHEDULER_TOKEN",
  "GRAM_OBJECT_STORE_TOKEN",
  "GRAM_HOST_PROVIDER_TOKEN",
];

/**
 * Takes the embedding secrets out of `env`, once they have been read from it. Agents, terminals and
 * `git` all start with the server's environment, and an agent holding the inbound token could
 * call the server as the platform does.
 */
export const scrubEmbedSecrets = (env: Record<string, string | undefined>): void => {
  for (const name of SECRET_VARIABLES) delete env[name];
};

/**
 * Reads the embedding variables; `undefined` when none is set. A malformed value throws at start
 * rather than half-configure.
 */
export const embedFromEnv = (
  env: Record<string, string | undefined> = process.env,
): EmbedConfigShape | undefined => {
  const inboundToken = tokenOf("GRAM_EMBED_TOKEN", env["GRAM_EMBED_TOKEN"]);
  const scheduler = service(env, "GRAM_SCHEDULER");
  const objectStore = service(env, "GRAM_OBJECT_STORE");
  const hostProvider = service(env, "GRAM_HOST_PROVIDER");
  const events = env["GRAM_REPO_EVENTS"];
  if (events !== undefined && events !== "" && events !== "pushed" && events !== "poll") {
    throw new Error("GRAM_REPO_EVENTS must be `pushed` or `poll`");
  }
  // Pushed events, and a scheduler's calls back, have nowhere to arrive without the inbound token.
  if (events === "pushed" && inboundToken === undefined) {
    throw new Error("GRAM_REPO_EVENTS=pushed needs GRAM_EMBED_TOKEN");
  }
  if (scheduler !== undefined && inboundToken === undefined) {
    throw new Error("GRAM_SCHEDULER_URL needs GRAM_EMBED_TOKEN, for the scheduler's calls back");
  }
  // A provider reports how a start goes on `/embed/v1/hosts/progress`.
  if (hostProvider !== undefined && inboundToken === undefined) {
    throw new Error("GRAM_HOST_PROVIDER_URL needs GRAM_EMBED_TOKEN, for the provider's progress");
  }
  if (
    inboundToken === undefined &&
    scheduler === undefined &&
    objectStore === undefined &&
    hostProvider === undefined &&
    events !== "pushed"
  ) {
    return undefined;
  }
  return {
    repoEvents: events === "pushed" ? "pushed" : "poll",
    ...(inboundToken === undefined ? {} : { inboundToken }),
    ...(scheduler === undefined ? {} : { scheduler }),
    ...(objectStore === undefined ? {} : { objectStore }),
    ...(hostProvider === undefined ? {} : { hostProvider }),
  };
};
