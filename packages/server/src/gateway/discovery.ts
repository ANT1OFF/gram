import {
  fieldsOf,
  GatewayError,
  type GatewayModel,
  type GatewayModelInfo,
  type GatewayModelPrice,
  type GatewayProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Predicate from "effect/Predicate";

/** The subset of `fetch` discovery needs; injected in tests. */
export type Fetcher = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

const DISCOVERY_TIMEOUT_MS = 15_000;

const REDIRECTS_MAX = 3;

/**
 * `fetch` for a gateway's models and catalog: it follows a redirect only within the origin it was
 * asked of, so a gateway's address never sends the request, with its key, to another host.
 */
export const sameOriginFetch: Fetcher = async (url, init) => {
  let at = url;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop++) {
    const response = await fetch(at, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    const next = new URL(location, at);
    if (next.origin !== new URL(at).origin)
      throw new Error("the gateway redirected to another origin");
    at = next.href;
  }
  throw new Error("the gateway redirected too often");
};

/** What a gateway's base URL that isn't a plain http(s) address is told. */
export const BASE_URL_SHAPE =
  "A gateway's base URL is an http or https address with no user name or password in it.";

/** Whether `baseURL` is a plain http(s) address, with no credentials in it. */
export const plainBaseURL = (baseURL: string): boolean => {
  try {
    const url = new URL(baseURL);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

const modelsUrl = (baseURL: string) => `${baseURL.replace(/\/+$/, "")}/models`;

const hostOf = (baseURL: string) => {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
};

/** Model ids from an OpenAI-style `/models` body (`{ data: [{ id }] }`, or a bare array); null if neither. */
export const parseModelIds = (body: unknown): Array<string> | null => {
  const list = Array.isArray(body) ? body : fieldsOf(body).get("data");
  if (!Array.isArray(list)) return null;
  const ids = list
    .map((entry) => fieldsOf(entry).get("id"))
    .filter((id): id is string => typeof id === "string" && id !== "");
  return [...new Set(ids)];
};

/** A metadata endpoint is opt-in and HTTPS only. No hostname grants implicit trust. */
export const catalogUrl = (
  profile: Pick<GatewayProfile, "modelCatalogURL">,
): string | undefined => {
  try {
    const url = new URL(profile.modelCatalogURL ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const flag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/**
 * Optional model descriptions by name from a user-configured catalog: an array of LiteLLM `model_info`
 * entries, each with its capability flags under `supports` and its token limits under `limits`.
 * `null` when the body isn't one.
 */
export const parseModelInfo = (body: unknown): Map<string, GatewayModelInfo> | null => {
  if (!Array.isArray(body)) return null;
  const infos = new Map<string, GatewayModelInfo>();
  for (const entry of body) {
    if (!Predicate.isObject(entry)) continue;
    const record = entry;
    const name = record["name"];
    if (typeof name !== "string" || name === "") continue;
    const supports = (record["supports"] ?? {}) as Record<string, unknown>;
    const limits = (record["limits"] ?? {}) as Record<string, unknown>;
    const maxInput = limits["max_input_tokens"];
    const fields: Record<string, unknown> = {
      mode: typeof record["mode"] === "string" ? record["mode"] : undefined,
      deprecated: flag(record["deprecated"]),
      restricted: flag(record["restricted"]),
      tools: flag(supports["supports_function_calling"]),
      reasoning: flag(supports["supports_reasoning"]),
      noneEffort:
        record["thinking_always_on"] === true
          ? false
          : flag(supports["supports_none_reasoning_effort"]),
      xhighEffort: flag(supports["supports_xhigh_reasoning_effort"]),
      maxEffort: flag(supports["supports_max_reasoning_effort"]),
      webSearch: flag(supports["supports_web_search"]),
      maxInputTokens: Number.isInteger(maxInput) ? maxInput : undefined,
    };
    infos.set(
      name,
      Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ) as GatewayModelInfo,
    );
  }
  return infos;
};

/** What a `/models` entry says of itself, as OpenRouter's and xAI's do: a name, a context, its parameters. */
export interface InlineModel {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly info: GatewayModelInfo;
  readonly price?: GatewayModelPrice;
}

const positiveInt = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;

const XAI_PRICE_PER_MTOK = 10_000;

const xaiPrice = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value / XAI_PRICE_PER_MTOK
    : undefined;

const xaiModel = (record: Record<string, unknown>): InlineModel => {
  const input = xaiPrice(record["prompt_text_token_price"]);
  const output = xaiPrice(record["completion_text_token_price"]);
  const cachedInput = xaiPrice(record["cached_prompt_text_token_price"]);
  const capabilities = (record["capabilities"] ?? {}) as Record<string, unknown>;
  const efforts = Array.isArray(capabilities["reasoning_effort"])
    ? capabilities["reasoning_effort"].filter((effort) => typeof effort === "string")
    : [];
  const chat = output !== undefined && output > 0;
  const contextWindow = positiveInt(record["context_length"]);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    info: chat
      ? {
          mode: "chat",
          tools: true,
          reasoning: efforts.length > 0,
          ...(efforts.length > 0
            ? { noneEffort: false, xhighEffort: efforts.includes("xhigh"), maxEffort: false }
            : {}),
        }
      : { mode: "image_generation" },
    ...(chat && input !== undefined
      ? { price: { input, ...(cachedInput === undefined ? {} : { cachedInput }), output } }
      : {}),
  };
};

/**
 * Descriptions carried in the `/models` body itself: for the entries that list their
 * `supported_parameters` (OpenRouter's format), `tools` means it takes function tools, `reasoning`
 * an effort; xAI's carry prices and efforts instead. A LiteLLM body has none, so this is empty for it.
 */
export const parseInlineModels = (body: unknown): Map<string, InlineModel> => {
  const list = Array.isArray(body) ? body : fieldsOf(body).get("data");
  const models = new Map<string, InlineModel>();
  if (!Array.isArray(list)) return models;
  for (const entry of list) {
    if (!Predicate.isObject(entry)) continue;
    const record = entry;
    const id = record["id"];
    if (typeof id !== "string" || id === "") continue;
    if ("prompt_text_token_price" in record || "completion_text_token_price" in record) {
      models.set(id, xaiModel(record));
      continue;
    }
    const parameters = record["supported_parameters"];
    if (!Array.isArray(parameters)) continue;
    const name = record["name"];
    const contextWindow = positiveInt(record["context_length"]);
    models.set(id, {
      ...(typeof name === "string" && name !== "" ? { name } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      info: {
        mode: "chat",
        tools: parameters.includes("tools"),
        reasoning: parameters.includes("reasoning"),
      },
    });
  }
  return models;
};

/**
 * The discovered models, keeping any existing entry's name, context window and variants. `infos`
 * replaces each model's description, when the gateway's catalog could be read; otherwise the last
 * one read stays.
 */
export const mergeModels = (
  existing: ReadonlyArray<GatewayModel>,
  discovered: ReadonlyArray<string>,
  infos?: ReadonlyMap<string, GatewayModelInfo>,
  inline: ReadonlyMap<string, InlineModel> = new Map(),
): Array<GatewayModel> => {
  const byId = new Map(existing.map((model) => [model.id, model]));
  return discovered.map((id) => {
    const own = inline.get(id);
    const kept = byId.get(id);
    let model: GatewayModel = kept ?? { id, name: own?.name ?? id };
    if (own !== undefined) {
      model = {
        ...model,
        ...(own.name !== undefined && model.name === id ? { name: own.name } : {}),
        ...(own.contextWindow !== undefined && model.contextWindow === undefined
          ? { contextWindow: own.contextWindow }
          : {}),
        info: own.info,
      };
      const { price: _stale, ...unpriced } = model;
      model = own.price === undefined ? unpriced : { ...unpriced, price: own.price };
    }
    if (infos === undefined) return model;
    const { info: _stale, ...rest } = model;
    const info = infos.get(id);
    return info === undefined ? rest : { ...rest, info };
  });
};

const readCatalog = (url: string, fetcher: Fetcher) =>
  Effect.tryPromise({
    try: (signal) => fetcher(url, { headers: { Accept: "application/json" }, signal }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({ try: () => response.json(), catch: () => undefined })
        : Effect.fail(undefined),
    ),
    Effect.map((body) => parseModelInfo(body) ?? undefined),
    Effect.timeoutOrElse({
      duration: DISCOVERY_TIMEOUT_MS,
      orElse: () => Effect.succeed(undefined),
    }),
    Effect.orElseSucceed(() => undefined),
  );

/** Lists the gateway's models with the profile's key. Errors name the host, never the key. */
export const discoverModels = (
  profile: GatewayProfile,
  key: Redacted.Redacted<string>,
  fetcher: Fetcher,
): Effect.Effect<Array<GatewayModel>, GatewayError> =>
  Effect.gen(function* () {
    const fail = (message: string) => new GatewayError({ profileId: profile.id, message });
    const host = hostOf(profile.baseURL);
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(modelsUrl(profile.baseURL), {
          headers: { Authorization: `Bearer ${Redacted.value(key)}`, Accept: "application/json" },
          signal,
        }),
      catch: () => fail(`Couldn't reach ${host}`),
    }).pipe(
      Effect.timeoutOrElse({
        duration: DISCOVERY_TIMEOUT_MS,
        orElse: () => Effect.fail(fail(`${host} didn't answer within 15 s`)),
      }),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* fail(`${host} rejected the key (${response.status})`);
    }
    if (!response.ok) return yield* fail(`${host} answered ${response.status}`);
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => fail(`${host} didn't return JSON`),
    });
    const ids = parseModelIds(body);
    if (ids === null) return yield* fail(`${host}'s model list isn't in the OpenAI format`);
    const url = catalogUrl(profile);
    const infos = url === undefined ? undefined : yield* readCatalog(url, fetcher);
    return mergeModels(profile.models, ids, infos, parseInlineModels(body));
  });
