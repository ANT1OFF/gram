import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RepoEvents, type PushedRepoEvent } from "../git/publisher.ts";
import { Embedding } from "./embedding.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";

/** How many events one call may carry. */
export const REPO_EVENTS_MAX = 200;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const KINDS: ReadonlySet<string> = new Set(["pull_request", "check", "review", "comment"]);

/** One event of the call's body, or why it isn't one. */
export const parseRepoEvent = (value: unknown): PushedRepoEvent | string => {
  if (typeof value !== "object" || value === null) return "an event is an object";
  const { repo, number, branch, kind } = value as Record<string, unknown>;
  if (typeof repo !== "string" || !REPO.test(repo)) return "`repo` is `owner/name`";
  if (number !== undefined && (!Number.isSafeInteger(number) || (number as number) <= 0)) {
    return "`number` is a pull request's number";
  }
  if (
    branch !== undefined &&
    (typeof branch !== "string" || branch === "" || branch.length > 255)
  ) {
    return "`branch` is a branch's name";
  }
  if (kind !== undefined && (typeof kind !== "string" || !KINDS.has(kind))) {
    return "`kind` is one of pull_request, check, review, comment";
  }
  return {
    repo,
    ...(number === undefined ? {} : { number: number as number }),
    ...(branch === undefined ? {} : { branch }),
  };
};

/** Serves `repo-events`; provides nothing. */
export const RepoEventsInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const repoEvents = yield* RepoEvents;
    const embedding = yield* Embedding;
    yield* inbound.route("POST", "repo-events", (body) =>
      Effect.gen(function* () {
        if (embedding.config.repoEvents !== "pushed") {
          return refusal(409, "repository events aren't pushed here (GRAM_REPO_EVENTS)");
        }
        const listed = body?.["events"];
        if (!Array.isArray(listed) || listed.length === 0 || listed.length > REPO_EVENTS_MAX) {
          return refusal(400, `\`events\` is a list of 1 to ${REPO_EVENTS_MAX} events`);
        }
        const events = new Map<string, PushedRepoEvent>();
        for (const each of listed) {
          const event = parseRepoEvent(each);
          if (typeof event === "string") return refusal(400, event);
          events.set(
            `${event.repo.toLowerCase()}#${event.number ?? ""}@${event.branch ?? ""}`,
            event,
          );
        }
        let checkouts = 0;
        for (const event of events.values()) checkouts += yield* repoEvents.pushed(event);
        yield* Effect.logDebug("repository events pushed").pipe(
          Effect.annotateLogs({ events: listed.length, checkouts }),
        );
        return answer({ accepted: listed.length, checkouts });
      }),
    );
  }),
);
