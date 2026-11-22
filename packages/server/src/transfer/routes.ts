import {
  anyPrivate,
  currentReader,
  NOT_READABLE,
  readableByOfWorkspace,
  readerMay,
} from "../embedding/readable-by.ts";
import {
  BUNDLE_MAX_BYTES,
  embeddingOn,
  ExportWorkspaceInput,
  type WorkspaceId,
  ImportWorkspaceInput,
  type InvalidState,
  type NotFound,
  type ThreadNotFound,
} from "@gram/contracts";
import {
  ExportThreadInput,
  ImportThreadInput,
  SettledThereInput,
  SettleThreadInput,
} from "@gram/contracts/thread-transfer";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { authTarget } from "../http/auth-target.ts";
import {
  THREAD_EXPORT_PATH,
  THREAD_IMPORT_PATH,
  THREAD_SETTLE_PATH,
  THREAD_SETTLED_THERE_PATH,
  WORKSPACE_EXPORT_PATH,
  WORKSPACE_IMPORT_PATH,
} from "../http/remote-access.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { ThreadTransfer, type ThreadTransferShape } from "./thread-transfer.ts";
import { WorkspaceTransfer, type WorkspaceTransferShape } from "./workspace-transfer.ts";

export {
  THREAD_EXPORT_PATH,
  THREAD_IMPORT_PATH,
  THREAD_SETTLE_PATH,
  THREAD_SETTLED_THERE_PATH,
  WORKSPACE_EXPORT_PATH,
  WORKSPACE_IMPORT_PATH,
};

/**
 * Reached only from the local app: a bundle is a whole workspace or a thread with its edits, and
 * an import names folders.
 */
export const WORKSPACE_TRANSFER_PATHS: ReadonlySet<string> = new Set([
  WORKSPACE_EXPORT_PATH,
  WORKSPACE_IMPORT_PATH,
  THREAD_EXPORT_PATH,
  THREAD_IMPORT_PATH,
  THREAD_SETTLE_PATH,
  THREAD_SETTLED_THERE_PATH,
]);

const EXPORT_BODY_MAX = 1_024;

const refuse = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status });

const notThere = HttpServerResponse.text("not found", { status: 404 });

const body = (max: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
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

const refusal = (error: NotFound | ThreadNotFound | InvalidState) =>
  error._tag === "ThreadNotFound"
    ? refuse("There is no such thread here.", 404)
    : refuse(error.message, error._tag === "NotFound" ? 404 : 409);

/**
 * Answers one of the two paths. `on` is the hosted features setting, read per request; the body
 * is decoded against the contract before the service sees it, so nothing unknown gets in.
 */
export const workspaceTransferRoute = (
  transfer: WorkspaceTransferShape & ThreadTransferShape,
  on: Effect.Effect<boolean>,
  path: string,
  mayExport?: (workspaceId: WorkspaceId) => Effect.Effect<boolean>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (authTarget(request.url)?.path !== path) return notThere;
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
      if (mayExport !== undefined && !(yield* mayExport(input.value.workspaceId)))
        return refuse(NOT_READABLE, 404);
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
    if (path === THREAD_EXPORT_PATH || path === THREAD_SETTLE_PATH) {
      const read = yield* body(EXPORT_BODY_MAX);
      if (read.refused !== undefined) return read.refused;
      if (path === THREAD_EXPORT_PATH) {
        const input = yield* Schema.decodeUnknownEffect(ExportThreadInput)(read.value).pipe(
          Effect.option,
        );
        if (input._tag === "None") return refuse("Name the thread to export.", 400);
        return yield* transfer.exportThread(input.value).pipe(
          Effect.map((bundle) => HttpServerResponse.jsonUnsafe(bundle)),
          Effect.catch((error) => Effect.succeed(refusal(error))),
        );
      }
      const input = yield* Schema.decodeUnknownEffect(SettleThreadInput)(read.value).pipe(
        Effect.option,
      );
      if (input._tag === "None") return refuse("Name the thread and where it went.", 400);
      return yield* transfer.settleThread(input.value).pipe(
        Effect.map((thread) => HttpServerResponse.jsonUnsafe({ thread })),
        Effect.catch((error) => Effect.succeed(refusal(error))),
      );
    }
    if (path === THREAD_SETTLED_THERE_PATH) {
      const read = yield* body(EXPORT_BODY_MAX);
      if (read.refused !== undefined) return read.refused;
      const input = yield* Schema.decodeUnknownEffect(SettledThereInput)(read.value).pipe(
        Effect.option,
      );
      if (input._tag === "None") return refuse("Name the thread.", 400);
      return yield* transfer.settledThere(input.value.threadId).pipe(
        Effect.map((thread) => HttpServerResponse.jsonUnsafe({ thread })),
        Effect.catch((error) => Effect.succeed(refusal(error))),
      );
    }
    if (path === THREAD_IMPORT_PATH) {
      const read = yield* body(BUNDLE_MAX_BYTES);
      if (read.refused !== undefined) return read.refused;
      const input = yield* Schema.decodeUnknownEffect(ImportThreadInput)(read.value).pipe(
        Effect.option,
      );
      if (input._tag === "None")
        return refuse("This is not a thread bundle this Gram can read.", 400);
      return yield* transfer.importThread(input.value).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catch((error) => Effect.succeed(refusal(error))),
      );
    }
    return notThere;
  });

/** The routes on the server's router, under its auth middleware. */
export const WorkspaceTransferRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const transfer = { ...(yield* WorkspaceTransfer), ...(yield* ThreadTransfer) };
    const store = yield* ThreadStore;
    const on = store.getSettings.pipe(
      Effect.map(embeddingOn),
      Effect.orElseSucceed(() => false),
    );
    const one = yield* Semaphore.make(1);
    const mayExport = (workspaceId: WorkspaceId) =>
      Effect.gen(function* () {
        if (!anyPrivate()) return true;
        const state = yield* store.getWorkspace(workspaceId).pipe(Effect.option);
        const holder =
          state._tag === "Some" ? state.value.workspace.orchestratorThreadId : undefined;
        return readerMay(yield* currentReader, readableByOfWorkspace(workspaceId, holder));
      });
    const handle = (path: string) => () =>
      one.withPermits(1)(workspaceTransferRoute(transfer, on, path, mayExport));
    return Layer.mergeAll(
      HttpRouter.add("*", WORKSPACE_EXPORT_PATH, handle(WORKSPACE_EXPORT_PATH)),
      HttpRouter.add("*", WORKSPACE_IMPORT_PATH, handle(WORKSPACE_IMPORT_PATH)),
      HttpRouter.add("*", THREAD_EXPORT_PATH, handle(THREAD_EXPORT_PATH)),
      HttpRouter.add("*", THREAD_IMPORT_PATH, handle(THREAD_IMPORT_PATH)),
      HttpRouter.add("*", THREAD_SETTLE_PATH, handle(THREAD_SETTLE_PATH)),
      HttpRouter.add("*", THREAD_SETTLED_THERE_PATH, handle(THREAD_SETTLED_THERE_PATH)),
    );
  }),
);
