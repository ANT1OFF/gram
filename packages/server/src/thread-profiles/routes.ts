// `POST /threads/from-profile`: a thread started from a profile by a fronting platform's own
// service (its statement for this path), or by the local app; never by a person signed in through
// the proxy, nor by a paired phone. While the hosted features setting is off it answers as a path
// that isn't there.
import {
  embeddingOn,
  PROFILE_START_PATH,
  ProfileStartRequest,
  type ProfileStartResponse,
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

export { PROFILE_START_PATH };

/** A profile's files hold at most 1 MB; the rest of a body is small beside them. */
const BODY_MAX = 2_000_000;

const refuse = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const notThere = HttpServerResponse.text("not found", { status: 404 });

const decodeRequest = Schema.decodeUnknownEffect(ProfileStartRequest);

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
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Only under its one spelling: the checks above this route match the path exactly.
    if (authTarget(request.url)?.path !== PROFILE_START_PATH) return notThere;
    if (!(yield* on)) return notThere;
    if (request.method !== "POST")
      return HttpServerResponse.text("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    // A form or a plain-text post from another page is never a start.
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
      return refuse("Send the body as application/json.", 415);
    const length = Number(request.headers["content-length"]);
    if (Number.isFinite(length) && length > BODY_MAX)
      return refuse(`The body is larger than ${BODY_MAX} bytes.`, 413);
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(BODY_MAX)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined)
      return refuse(`The body couldn't be read, or is larger than ${BODY_MAX} bytes.`, 413);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refuse("The body is not JSON.", 400);
    }
    const input = yield* decodeRequest(value, { onExcessProperty: "error" }).pipe(Effect.option);
    if (input._tag === "None")
      return refuse("Give the profile and the thread's id, and the machine's if it has one.", 400);
    const { profile, threadId, hostId } = input.value;
    return yield* starter.startOne(profile, { threadId, on: hostId }).pipe(
      Effect.map(({ thread, created }) =>
        HttpServerResponse.jsonUnsafe({
          threadId: thread.id,
          created,
        } satisfies ProfileStartResponse),
      ),
      // The starter's own sentence, and nothing of how it failed inside.
      Effect.catch((error) => Effect.succeed(refuse(error.message, 409))),
    );
  });

/** The route on the server's router, under its auth middleware. */
export const ProfileStartRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const starter = yield* ProfileStarters;
    const store = yield* ThreadStore;
    const on = store.getSettings.pipe(
      Effect.map(embeddingOn),
      Effect.orElseSucceed(() => false),
    );
    return HttpRouter.add("*", PROFILE_START_PATH, () => profileStartRoute(starter, on));
  }),
);
