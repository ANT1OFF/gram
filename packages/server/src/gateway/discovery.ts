import {
  GatewayError,
  type GatewayModel,
  type GatewayModelInfo,
  type GatewayProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** The subset of `fetch` discovery needs; injected in tests. */
export type Fetcher = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

const DISCOVERY_TIMEOUT_MS = 15_000;

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
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return null;
  const ids = list
    .map((entry) => (entry as { id?: unknown } | null)?.id)
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
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
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
      // Claude's 5.5 models can't turn thinking off, and the catalog says so outside `supports`.
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

/**
 * The discovered models, keeping any existing entry's name, context window and variants. `infos`
 * replaces each model's description, when the gateway's catalog could be read; otherwise the last
 * one read stays.
 */
export const mergeModels = (
  existing: ReadonlyArray<GatewayModel>,
  discovered: ReadonlyArray<string>,
  infos?: ReadonlyMap<string, GatewayModelInfo>,
): Array<GatewayModel> => {
  const byId = new Map(existing.map((model) => [model.id, model]));
  return discovered.map((id) => {
    const model = byId.get(id) ?? { id, name: id };
    if (infos === undefined) return model;
    const { info: _stale, ...rest } = model;
    const info = infos.get(id);
    return info === undefined ? rest : { ...rest, info };
  });
};

/** The gateway's own catalog, or `undefined` when it has none or it can't be read: it's optional. */
const readCatalog = (url: string, fetcher: Fetcher) =>
  Effect.tryPromise({
    // Metadata is fetched without the profile key or cookies.
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
    return mergeModels(profile.models, ids, infos);
  });
