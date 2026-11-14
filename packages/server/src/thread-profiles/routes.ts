// `POST /threads/from-profile`: a thread started from a profile by a fronting platform's own
// service (its statement for this path), or by the local app; never by a person signed in through
// the proxy, nor by a paired phone. While the hosted features setting is off it answers as a path
// that isn't there. Beside it, `POST /threads/move-to-machine` places such a thread on a machine,
// and `POST /threads/machine-wait` says how the wait of one started before its machine stands.
import {
  embeddingOn,
  PROFILE_MOVE_PATH,
  PROFILE_START_PATH,
  ProfileMoveRequest,
  type ProfileMoveResponse,
  ProfileStartRequest,
  type ProfileStartResponse,
  PROFILE_WAIT_MESSAGE_MAX,
  PROFILE_WAIT_PATH,
  ProfileWaitRequest,
  type ProfileWaitResponse,
} from "@gram/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { authTarget } from "../http/auth-target.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { ProfileStarters } from "./service.ts";
import type { ProfileStarter } from "./start.ts";

export { PROFILE_MOVE_PATH, PROFILE_START_PATH, PROFILE_WAIT_PATH };

/** A profile's files hold at most 1 MB; the rest of a body is small beside them. */
const BODY_MAX = 2_000_000;

const refuse = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const notThere = HttpServerResponse.text("not found", { status: 404 });

const decodeRequest = Schema.decodeUnknownEffect(ProfileStartRequest);
const decodeMove = Schema.decodeUnknownEffect(ProfileMoveRequest);
const decodeWait = Schema.decodeUnknownEffect(ProfileWaitRequest);

/**
 * Headers the answer carries for the service-call record (`server.ts`): which thread, where, and
 * whether this call made it. Nothing the body doesn't already say, beside the machine asked for.
 */
export const PROFILE_START_RECORD = {
  thread: "x-gram-thread",
  created: "x-gram-created",
  host: "x-gram-host",
  moved: "x-gram-moved",
} as const;

/**
 * The JSON body of a POST to `path`, or the answer that refuses it: a path that isn't there under
 * another spelling or with the hosted features off, another method, another content type, or a
 * body too large or not JSON.
 */
const jsonBodyAt = (
  path: string,
  on: Effect.Effect<boolean>,
): Effect.Effect<
  { readonly value?: unknown; readonly answer?: HttpServerResponse.HttpServerResponse },
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Only under its one spelling: the checks above this route match the path exactly.
    if (authTarget(request.url)?.path !== path) return { answer: notThere };
    if (!(yield* on)) return { answer: notThere };
    if (request.method !== "POST")
      return {
        answer: HttpServerResponse.text("method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        }),
      };
    // A form or a plain-text post from another page is never a start.
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
      return { answer: refuse("Send the body as application/json.", 415) };
    const length = Number(request.headers["content-length"]);
    if (Number.isFinite(length) && length > BODY_MAX)
      return { answer: refuse(`The body is larger than ${BODY_MAX} bytes.`, 413) };
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(BODY_MAX)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined)
      return {
        answer: refuse(`The body couldn't be read, or is larger than ${BODY_MAX} bytes.`, 413),
      };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { answer: refuse("The body is not JSON.", 400) };
    }
    return { value };
  });

/** Answers the path. `on` is the hosted features setting, read per request. */
export const profileStartRoute = (
  starter: Pick<ProfileStarter, "startOne">,
  on: Effect.Effect<boolean>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const body = yield* jsonBodyAt(PROFILE_START_PATH, on);
    if (body.answer !== undefined) return body.answer;
    const value = body.value;
    const input = yield* decodeRequest(value, { onExcessProperty: "error" }).pipe(Effect.option);
    if (input._tag === "None")
      return refuse("Give the profile and the thread's id, and the machine's if it has one.", 400);
    const { profile, threadId, hostId, machine, startedBy } = input.value;
    return yield* starter.startOne(profile, { threadId, on: hostId, machine, startedBy }).pipe(
      Effect.map(({ thread, created }) =>
        HttpServerResponse.jsonUnsafe(
          {
            threadId: thread.id,
            created,
            ...(thread.awaitingMachine === undefined ? {} : { awaitingMachine: true }),
          } satisfies ProfileStartResponse,
          {
            headers: {
              [PROFILE_START_RECORD.thread]: thread.id,
              [PROFILE_START_RECORD.created]: String(created),
              // A thread that waits for its machine is on none, and its record names none.
              ...(thread.checkout.hostId === undefined || thread.awaitingMachine !== undefined
                ? {}
                : { [PROFILE_START_RECORD.host]: thread.checkout.hostId }),
            },
          },
        ),
      ),
      // The starter's own sentence, and nothing of how it failed inside.
      Effect.catch((error) => Effect.succeed(refuse(error.message, 409))),
    );
  });

/** Answers the move path. `on` is the hosted features setting, read per request. */
export const profileMoveRoute = (
  starter: Pick<ProfileStarter, "moveOne">,
  on: Effect.Effect<boolean>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const body = yield* jsonBodyAt(PROFILE_MOVE_PATH, on);
    if (body.answer !== undefined) return body.answer;
    const input = yield* decodeMove(body.value, { onExcessProperty: "error" }).pipe(Effect.option);
    if (input._tag === "None")
      return refuse(
        "Give the thread's id and the machine's, and the profile if it has files.",
        400,
      );
    const { threadId, hostId, profile, lost } = input.value;
    return yield* starter.moveOne(threadId, hostId, profile, { lost: lost === true }).pipe(
      Effect.map(({ thread, moved }) =>
        HttpServerResponse.jsonUnsafe(
          { threadId: thread.id, hostId, moved } satisfies ProfileMoveResponse,
          {
            headers: {
              [PROFILE_START_RECORD.thread]: thread.id,
              [PROFILE_START_RECORD.host]: hostId,
              [PROFILE_START_RECORD.moved]: String(moved),
            },
          },
        ),
      ),
      Effect.catch((error) => Effect.succeed(refuse(error.message, 409))),
    );
  });

/** Answers the wait path. `on` is the hosted features setting, read per request. */
export const profileWaitRoute = (
  starter: Pick<ProfileStarter, "waitOne">,
  on: Effect.Effect<boolean>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const body = yield* jsonBodyAt(PROFILE_WAIT_PATH, on);
    if (body.answer !== undefined) return body.answer;
    const input = yield* decodeWait(body.value, { onExcessProperty: "error" }).pipe(Effect.option);
    if (
      input._tag === "None" ||
      (input.value.failed !== undefined && input.value.failed.length > PROFILE_WAIT_MESSAGE_MAX)
    )
      return refuse(
        `Give the thread's id, and why no machine is coming in at most ${PROFILE_WAIT_MESSAGE_MAX} characters, or nothing to begin the wait again.`,
        400,
      );
    const { threadId, failed } = input.value;
    return yield* starter.waitOne(threadId, { failed }).pipe(
      Effect.map((awaitingMachine) =>
        HttpServerResponse.jsonUnsafe({ threadId, awaitingMachine } satisfies ProfileWaitResponse, {
          headers: { [PROFILE_START_RECORD.thread]: threadId },
        }),
      ),
      Effect.catch((error) => Effect.succeed(refuse(error.message, 409))),
    );
  });

/** The routes on the server's router, under its auth middleware. */
export const ProfileStartRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const starter = yield* ProfileStarters;
    const store = yield* ThreadStore;
    const on = store.getSettings.pipe(
      Effect.map(embeddingOn),
      Effect.orElseSucceed(() => false),
    );
    return Layer.mergeAll(
      HttpRouter.add("*", PROFILE_START_PATH, () => profileStartRoute(starter, on)),
      HttpRouter.add("*", PROFILE_MOVE_PATH, () => profileMoveRoute(starter, on)),
      HttpRouter.add("*", PROFILE_WAIT_PATH, () => profileWaitRoute(starter, on)),
    );
  }),
);
