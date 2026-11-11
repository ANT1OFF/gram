// `POST /workspaces/export` and `POST /workspaces/import`: a workspace out of this server as a
// bundle, and a bundle into it. The auth middleware lets only the local app's own origin reach
// them, never a paired browser or a joined machine; while the hosted features setting is off they
// answer as a path that isn't there.

import {
  BUNDLE_MAX_BYTES,
  embeddingOn,
  ExportWorkspaceInput,
  ImportWorkspaceInput,
  type InvalidState,
  type NotFound,
} from "@gram/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { WorkspaceTransfer, type WorkspaceTransferShape } from "./workspace-transfer.ts";

export const WORKSPACE_EXPORT_PATH = "/workspaces/export";
export const WORKSPACE_IMPORT_PATH = "/workspaces/import";

/** Reached only from the local app: a bundle is a whole workspace, and an import names folders. */
export const WORKSPACE_TRANSFER_PATHS: ReadonlySet<string> = new Set([
  WORKSPACE_EXPORT_PATH,
  WORKSPACE_IMPORT_PATH,
]);

/** An export's body: a workspace id and a flag. */
const EXPORT_BODY_MAX = 1_024;

const refuse = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const notThere = HttpServerResponse.text("not found", { status: 404 });

/** The request's body as JSON of at most `max` bytes, or the response that refuses it. */
const body = (max: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A form or a plain-text post from another page is never a bundle.
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return { refused: refuse("Send the body as application/json.", 415) };
    }
    const length = Number(request.headers["content-length"]);
    if (Number.isFinite(length) && length > max) {
      return { refused: refuse(`The body is larger than ${max} bytes.`, 413) };
    }
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(max)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined) {
      return { refused: refuse(`The body couldn't be read, or is larger than ${max} bytes.`, 413) };
    }
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return { refused: refuse("The body is not JSON.", 400) };
    }
  });

/** What a refused move answers: the service's own sentence, and nothing of how it failed inside. */
const refusal = (error: NotFound | InvalidState) =>
  refuse(error.message, error._tag === "NotFound" ? 404 : 409);

/**
 * Answers one of the two paths. `on` is the hosted features setting, read per request; the body
 * is decoded against the contract before the service sees it, so nothing unknown gets in.
 */
export const workspaceTransferRoute = (
  transfer: WorkspaceTransferShape,
  on: Effect.Effect<boolean>,
  path: string,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* on)) return notThere;
    if (request.method !== "POST") {
      return HttpServerResponse.text("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (path === WORKSPACE_EXPORT_PATH) {
      const read = yield* body(EXPORT_BODY_MAX);
      if (read.refused !== undefined) return read.refused;
      const input = yield* Schema.decodeUnknownEffect(ExportWorkspaceInput)(read.value).pipe(
        Effect.option,
      );
      if (input._tag === "None") return refuse("Name the workspace to export.", 400);
      return yield* transfer.exportWorkspace(input.value).pipe(
        Effect.map((bundle) => HttpServerResponse.jsonUnsafe(bundle)),
        Effect.catch((error) => Effect.succeed(refusal(error))),
      );
    }
    if (path === WORKSPACE_IMPORT_PATH) {
      const read = yield* body(BUNDLE_MAX_BYTES);
      if (read.refused !== undefined) return read.refused;
      const input = yield* Schema.decodeUnknownEffect(ImportWorkspaceInput)(read.value).pipe(
        Effect.option,
      );
      if (input._tag === "None") {
        return refuse("This is not a workspace bundle this Gram can read.", 400);
      }
      return yield* transfer.importWorkspace(input.value).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catch((error) => Effect.succeed(refusal(error))),
      );
    }
    return notThere;
  });

/** The two routes on the server's router, under its auth middleware. */
export const WorkspaceTransferRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const transfer = yield* WorkspaceTransfer;
    const store = yield* ThreadStore;
    const on = store.getSettings.pipe(
      Effect.map(embeddingOn),
      Effect.orElseSucceed(() => false),
    );
    const handle = (path: string) => () => workspaceTransferRoute(transfer, on, path);
    return Layer.mergeAll(
      HttpRouter.add("*", WORKSPACE_EXPORT_PATH, handle(WORKSPACE_EXPORT_PATH)),
      HttpRouter.add("*", WORKSPACE_IMPORT_PATH, handle(WORKSPACE_IMPORT_PATH)),
    );
  }),
);
