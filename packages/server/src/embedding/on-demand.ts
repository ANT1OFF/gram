// Hosts an embedder provisions on demand, for one person each.
//
// A headless server runs no work itself (`host/headless.ts`): a thread needs a machine. With
// `GRAM_HOST_PROVIDER_URL` set, the deployment that runs this server can start one for the person
// who asks: a person signed in through the fronting proxy starts their machine with a plain HTTP
// request, which the proxy signs and can bind to that one request, and the server asks the
// provider to start a host for them, passing that statement on exactly as received as `proof`.
// The provider checks the proof itself, starts the host, and registers it here (as any
// provisioned host, through `/machines/provision`) with its `owner` and `onDemand` kind. From then
// on only that person's threads are placed on it, and only they see it.
//
// The provider reports how the start goes on `/embed/v1/hosts/progress`, which the person's
// status read shows. A person can stop their machine too. Nothing here starts a host without a
// person's own request: an agent, a skill or a repository's instructions have no path to it.

import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Actor } from "../http/fronted-identity.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import type { OutsideService } from "./config.ts";
import { Embedding } from "./embedding.ts";
import { EmbedInbound } from "./inbound.ts";
import { callOutside } from "./outside.ts";

export const ON_DEMAND_START_PATH = "/machines/on-demand/start";
export const ON_DEMAND_STOP_PATH = "/machines/on-demand/stop";
export const ON_DEMAND_STATUS_PATH = "/machines/on-demand/status";
export const ON_DEMAND_PATHS: ReadonlySet<string> = new Set([
  ON_DEMAND_START_PATH,
  ON_DEMAND_STOP_PATH,
  ON_DEMAND_STATUS_PATH,
]);

/** The largest start body: a few repository names. */
export const ON_DEMAND_MAX_BYTES = 8 * 1024;
/** `owner/name`, each starting with a letter or digit: never `.` or `..`. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_REPOSITORIES = 20;
const HOST_KEY = /^[\x21-\x7e]{1,200}$/;
const PHASES = [
  "starting",
  "booting",
  "joining",
  "ready",
  "stopping",
  "stopped",
  "failed",
] as const;
export type OnDemandPhase = (typeof PHASES)[number];

/** How a person's machine stands, as the provider last reported it. */
export interface OnDemandProgress {
  readonly hostKey: string;
  readonly phase: OnDemandPhase;
  /** A short line for the person: which step it is on, or why it failed. */
  readonly message?: string;
  readonly step?: string;
  readonly at: number;
}

/** A short id a provider names a choice or one of its options with: `size`, `arm64`. */
const CHOICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_CHOICES = 6;
const MAX_OPTIONS = 8;
/** How long a person's choices, as the provider offered them, are kept before it is asked again. */
export const CHOICES_TTL_MS = 30_000;

/** One option of a choice, as the provider offers it to one person. */
export interface OnDemandOption {
  readonly id: string;
  readonly label: string;
  /** What it is, in a few words: "4 CPU · 8 GB". */
  readonly detail?: string;
  /** Whether this person may pick it. One they may not is shown, with `note` saying why. */
  readonly available: boolean;
  readonly note?: string;
}

/** Something a person picks before their machine starts, such as its size. */
export interface OnDemandChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly options: ReadonlyArray<OnDemandOption>;
  /** What is picked when the person picks nothing: an available option. */
  readonly default: string;
}

/** The provider's choices for one person, and a line on whose limits they are. */
export interface OnDemandChoices {
  readonly choices: ReadonlyArray<OnDemandChoice>;
  readonly note?: string;
}

/** What the server knows of on-demand hosts: the provider, and each person's latest progress. */
export class OnDemandHosts extends Data.Class<{
  readonly provider: OutsideService;
  readonly progress: Map<string, OnDemandProgress>;
  /** Each person's choices as the provider last offered them, and when it was asked. */
  readonly choices: Map<string, { readonly at: number; readonly value?: OnDemandChoices }>;
}> {}

export const makeOnDemandHosts = (provider: OutsideService): OnDemandHosts =>
  new OnDemandHosts({ provider, progress: new Map(), choices: new Map() });

/** A machine as a person's status reads it. */
export interface OwnedMachine {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly onDemand?: "personal" | "thread" | undefined;
  readonly onlineSince?: number | undefined;
}

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });
const refusal = (status: number, tag: string, message: string) =>
  json(status, { _tag: tag, message });

/** What a person picked, by choice id: short ids only. */
export type Picked = Readonly<Record<string, string>>;

/** The start body, or why not. */
export const parseStart = (
  body: string,
): { readonly repositories: ReadonlyArray<string>; readonly choices: Picked } | string => {
  let value: unknown;
  try {
    value = body === "" ? {} : JSON.parse(body);
  } catch {
    return "the body is not JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "expected {repositories?, choices?}";
  const picked = "choices" in value ? value.choices : undefined;
  if (
    picked !== undefined &&
    (typeof picked !== "object" ||
      picked === null ||
      Array.isArray(picked) ||
      Object.keys(picked).length > MAX_CHOICES ||
      !Object.entries(picked).every(
        ([key, each]) => CHOICE_ID.test(key) && typeof each === "string" && CHOICE_ID.test(each),
      ))
  )
    return `\`choices\` names at most ${MAX_CHOICES} choices by short id, each with an option's id`;
  const choices: Picked = picked === undefined ? {} : { ...(picked as Record<string, string>) };
  const listed = "repositories" in value ? value.repositories : undefined;
  if (listed === undefined) return { repositories: [], choices };
  if (
    !Array.isArray(listed) ||
    listed.length > MAX_REPOSITORIES ||
    !listed.every((each) => typeof each === "string" && REPOSITORY.test(each))
  )
    return `\`repositories\` is a list of at most ${MAX_REPOSITORIES} owner/name`;
  return { repositories: [...new Set(listed as string[])], choices };
};

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value)
    ? value
    : undefined;

/** The provider's `/hosts/choices` answer, read field by field. Undefined: none that hold. */
export const parseChoices = (value: unknown): OnDemandChoices | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const listed = (value as { choices?: unknown }).choices;
  if (!Array.isArray(listed)) return undefined;
  const choices: OnDemandChoice[] = [];
  for (const raw of listed.slice(0, MAX_CHOICES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    const label = text(entry["label"], 60);
    if (typeof id !== "string" || !CHOICE_ID.test(id) || label === undefined) continue;
    if (!Array.isArray(entry["options"])) continue;
    const options: OnDemandOption[] = [];
    for (const each of entry["options"].slice(0, MAX_OPTIONS)) {
      if (typeof each !== "object" || each === null) continue;
      const option = each as Record<string, unknown>;
      const optionId = option["id"];
      const optionLabel = text(option["label"], 60);
      if (typeof optionId !== "string" || !CHOICE_ID.test(optionId) || optionLabel === undefined)
        continue;
      const detail = text(option["detail"], 80);
      const note = text(option["note"], 160);
      options.push({
        id: optionId,
        label: optionLabel,
        ...(detail === undefined ? {} : { detail }),
        available: option["available"] !== false,
        ...(note === undefined ? {} : { note }),
      });
    }
    const usable = options.filter((option) => option.available);
    if (usable.length === 0) continue;
    const asked = entry["default"];
    const description = text(entry["description"], 200);
    choices.push({
      id,
      label,
      ...(description === undefined ? {} : { description }),
      options,
      default: usable.some((option) => option.id === asked) ? (asked as string) : usable[0]!.id,
    });
  }
  if (choices.length === 0) return undefined;
  const note = text((value as { note?: unknown }).note, 200);
  return { choices, ...(note === undefined ? {} : { note }) };
};

/**
 * A person's choices, from the provider's `POST /hosts/choices` (`{owner}`), kept a short while.
 * A provider that offers none (404), or doesn't answer, gives none: the machine starts as it would.
 */
export const choicesFor = (hosts: OnDemandHosts, owner: string, now: number = Date.now()) =>
  Effect.gen(function* () {
    const kept = hosts.choices.get(owner);
    if (kept !== undefined && now - kept.at < CHOICES_TTL_MS) return kept.value;
    const answered = yield* callOutside("host provider", hosts.provider, {
      method: "POST",
      path: "/hosts/choices",
      json: { owner },
      accept: [404],
      timeoutMs: 5_000,
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
              Effect.as(undefined),
            )
          : Effect.promise(() => response.json().catch(() => undefined) as Promise<unknown>),
      ),
      Effect.result,
    );
    const value = answered._tag === "Success" ? parseChoices(answered.success) : undefined;
    hosts.choices.set(owner, { at: now, ...(value === undefined ? {} : { value }) });
    return value;
  });

/** A person's own machine: theirs, for work in a folder, the newest that is online first. */
export const ownMachine = (
  machines: ReadonlyArray<OwnedMachine>,
  person: string,
): OwnedMachine | undefined =>
  machines
    .filter((machine) => machine.owner === person && machine.onDemand === "personal")
    .toSorted((a, b) => (b.onlineSince ?? 0) - (a.onlineSince ?? 0))[0];

/** What `/machines/on-demand/status` answers a person. */
export const statusFor = (
  hosts: OnDemandHosts,
  machines: ReadonlyArray<OwnedMachine>,
  person: string,
  choices?: OnDemandChoices,
) => {
  const mine = ownMachine(machines, person);
  const progress = hosts.progress.get(person);
  return {
    available: true,
    ...(choices === undefined ? {} : { choices }),
    ...(mine === undefined
      ? {}
      : { machine: { id: mine.id, name: mine.name, online: mine.onlineSince !== undefined } }),
    ...(progress === undefined ? {} : { progress }),
  };
};

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const length = request.headers["content-length"];
    if (length !== undefined && Number(length) > ON_DEMAND_MAX_BYTES) return "too-large" as const;
    const bytes = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(ON_DEMAND_MAX_BYTES)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (bytes === undefined) return "unreadable" as const;
    try {
      // Kept exactly as sent, as the proxy hashed it.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return "unreadable" as const;
    }
  });

/**
 * Serves a person's `/machines/on-demand/*` request. `statement` is the proxy's signed statement
 * for it, exactly as received; it goes to the provider as the proof that this person asked.
 */
export const onDemandRequest = (
  hosts: OnDemandHosts,
  machines: () => ReadonlyArray<OwnedMachine>,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  actor: Actor,
  statement: string,
) =>
  Effect.gen(function* () {
    if (path === ON_DEMAND_STATUS_PATH) {
      if (request.method !== "GET") return refusal(405, "MethodNotAllowed", "method not allowed");
      const choices = yield* choicesFor(hosts, actor.id);
      return json(200, statusFor(hosts, machines(), actor.id, choices));
    }
    if (request.method !== "POST") return refusal(405, "MethodNotAllowed", "method not allowed");
    if (actor.role !== "member")
      return refusal(403, "Forbidden", "read-only: a viewer can't start or stop a machine");
    const body = yield* readBody(request);
    if (body === "too-large") return refusal(413, "TooLarge", "the request is too large");
    if (body === "unreadable") return refusal(400, "BadRequest", "the request could not be read");
    const proof = { statement, method: request.method, path: request.url, body };

    if (path === ON_DEMAND_STOP_PATH) {
      const progress = hosts.progress.get(actor.id);
      const mine = ownMachine(machines(), actor.id);
      if (progress === undefined && mine === undefined)
        return refusal(404, "NotFound", "you have no machine to stop");
      const answered = yield* callOutside("host provider", hosts.provider, {
        method: "POST",
        path: "/hosts/stop",
        json: {
          owner: actor.id,
          ...(progress === undefined ? {} : { hostKey: progress.hostKey }),
          ...(mine === undefined ? {} : { hostId: mine.id }),
          reason: "requested",
          proof,
        },
      }).pipe(Effect.result);
      if (answered._tag === "Failure")
        return refusal(502, "ProviderFailed", answered.failure.message);
      return json(202, { stopping: true });
    }

    const parsed = parseStart(body);
    if (typeof parsed === "string") return refusal(400, "BadRequest", parsed);
    const mine = ownMachine(machines(), actor.id);
    if (mine?.onlineSince !== undefined)
      return json(200, { machine: { id: mine.id, name: mine.name, online: true } });
    const answered = yield* callOutside("host provider", hosts.provider, {
      method: "POST",
      path: "/hosts/start",
      json: {
        kind: "personal",
        owner: actor.id,
        options: {
          repositories: parsed.repositories,
          ...(Object.keys(parsed.choices).length === 0 ? {} : { choices: parsed.choices }),
        },
        proof,
      },
    }).pipe(
      Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<unknown>)),
      Effect.result,
    );
    if (answered._tag === "Failure")
      return refusal(502, "ProviderFailed", answered.failure.message);
    const value = answered.success;
    const hostKey =
      typeof value === "object" && value !== null && "hostKey" in value ? value.hostKey : undefined;
    if (typeof hostKey !== "string" || !HOST_KEY.test(hostKey))
      return refusal(502, "ProviderFailed", "the host provider gave no host key");
    const progress: OnDemandProgress = { hostKey, phase: "starting", at: Date.now() };
    hosts.progress.set(actor.id, progress);
    return json(202, { progress });
  });

/** A short line a provider sends: one line, at most 300 characters. */
const line = (value: unknown) =>
  typeof value === "string" && value.length <= 300 && !/[\0\n\r]/.test(value) ? value : undefined;

/**
 * The provider's report on `/embed/v1/hosts/progress`: `{owner, hostKey, phase, step?,
 * message?}`. Only a host key this server asked for, for that owner, is taken.
 */
export const takeProgress = (
  hosts: OnDemandHosts,
  body: Record<string, unknown> | undefined,
  now: number = Date.now(),
): { readonly status: number; readonly body: Record<string, unknown> } => {
  const owner = body?.["owner"];
  const hostKey = body?.["hostKey"];
  const phase = body?.["phase"];
  if (typeof owner !== "string" || typeof hostKey !== "string")
    return { status: 400, body: { message: "`owner` and `hostKey` are required" } };
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase))
    return { status: 400, body: { message: `\`phase\` is one of ${PHASES.join(", ")}` } };
  const known = hosts.progress.get(owner);
  if (known === undefined || known.hostKey !== hostKey)
    return { status: 404, body: { message: "no start of that host is waiting for progress" } };
  const message = line(body?.["message"]);
  const step = line(body?.["step"]);
  hosts.progress.set(owner, {
    hostKey,
    phase: phase as OnDemandPhase,
    ...(message === undefined ? {} : { message }),
    ...(step === undefined ? {} : { step }),
    at: now,
  });
  return { status: 200, body: { taken: true } };
};

/** The on-demand hosts of this server: absent unless `GRAM_HOST_PROVIDER_URL` is set. */
export class OnDemand extends Context.Service<OnDemand, OnDemandHosts | undefined>()(
  "@gram/server/OnDemand",
) {}

/** Provides `OnDemand`, and serves the provider's `hosts/progress`, when a provider is set. */
export const OnDemandLive = Layer.effect(
  OnDemand,
  Effect.gen(function* () {
    const embedding = yield* Embedding;
    const provider = embedding.config.hostProvider;
    if (provider === undefined) return undefined;
    const hosts = makeOnDemandHosts(provider);
    const inbound = yield* EmbedInbound;
    yield* inbound.route("POST", "hosts/progress", (body) =>
      Effect.sync(() => {
        const taken = takeProgress(hosts, body);
        return { status: taken.status, body: taken.body };
      }),
    );
    return hosts;
  }),
);
