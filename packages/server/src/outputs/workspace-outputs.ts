import {
  checkoutRoots,
  effectiveCheckout,
  HOST_FILE_PART_BYTES,
  hostOf,
  InvalidState,
  isCredentialPath,
  isLocalHost,
  LOCAL_HOST_ID,
  OutputKind,
  outputKindOf,
  outputMediaType,
  OUTPUTS_PAGE,
  OUTPUTS_PAGE_MAX,
  OutputSource,
  sessionHostOf,
  type Thread,
  ThreadId,
  type WorkspaceId,
  type WorkspaceOutput,
  type WorkspaceOutputsPage,
} from "@gram/contracts";
import { isInside, tryRealPath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { appendFile, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { attachmentsDir } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { OBJECT_MAX_BYTES, ObjectStore, outputKey } from "../embedding/object-store.ts";
import { EventHub } from "../events/event-hub.ts";
import { expandHome } from "../fs/folders.ts";
import type { HostFileReads } from "../host/file-reads.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { ObservedOutput } from "./observed.ts";
import * as Schema from "effect/Schema";

const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

interface OutputsQuery {
  readonly kind?: OutputKind | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface WorkspaceOutputsShape {
  /**
   * Checks and records a file `threadId` produced, then tells its workspace's clients. Skipped, not
   * failed, when the file is missing, a link, a credential file, or somewhere the thread can't show.
   */
  readonly record: (threadId: ThreadId, output: ObservedOutput) => Effect.Effect<void>;
  /** The workspace's outputs, newest first; `InvalidState` for a cursor this didn't make. */
  readonly list: (
    workspaceId: WorkspaceId,
    query?: OutputsQuery,
  ) => Effect.Effect<WorkspaceOutputsPage, InvalidState>;
}

interface Checked {
  readonly path: string;
  readonly real: string;
  readonly size: number;
  readonly mtime: number;
}

const checkFile = async (
  path: string,
  roots: ReadonlyArray<string>,
  outside: boolean,
): Promise<Checked | undefined> => {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  const real = await tryRealPath(path);
  if (real === undefined) return undefined;
  const checked = { path, real, size: info.size, mtime: Math.trunc(info.mtimeMs) };
  if (outside) {
    const parent = await tryRealPath(dirname(path));
    return parent !== undefined && join(parent, basename(path)) === real ? checked : undefined;
  }
  for (const root of roots) {
    const realRoot = await tryRealPath(root);
    if (realRoot !== undefined && isInside(realRoot, real)) return checked;
  }
  return undefined;
};

const realOr = async (path: string) => (await tryRealPath(path)) ?? resolve(path);

const cursorOf = (at: number, seq: number) => `${at}.${seq}`;
const parseCursor = (cursor: string): { at: number; seq: number } | undefined => {
  const match = /^(\d+)\.(\d+)$/.exec(cursor);
  return match === null ? undefined : { at: Number(match[1]), seq: Number(match[2]) };
};

interface Row {
  readonly seq: number;
  readonly thread_id: string;
  readonly path: string;
  readonly kind: string;
  readonly source: string;
  readonly media_type: string;
  readonly size: number;
  readonly at: number;
  readonly title: string | null;
  readonly role: string | null;
  readonly feature: string | null;
}

const isKind = Schema.is(OutputKind);
const isSource = Schema.is(OutputSource);

const toOutput = (row: Row): ReadonlyArray<WorkspaceOutput> =>
  isKind(row.kind) && isSource(row.source) ? [outputOf(row, row.kind, row.source)] : [];

const outputOf = (row: Row, kind: OutputKind, source: OutputSource): WorkspaceOutput => ({
  id: String(row.seq),
  threadId: ThreadId.make(row.thread_id),
  threadTitle: row.title ?? "",
  orchestrator: row.role === "orchestrator",
  ...(row.feature === null ? {} : { feature: row.feature }),
  path: row.path,
  kind,
  source,
  mediaType: row.media_type,
  size: row.size,
  at: row.at,
});

const HOST_PART_TIMEOUT = Duration.seconds(60);
const HOST_PATH_MAX = 4096;

const stageFrom =
  (
    part: NonNullable<HostFileReads["part"]>,
    path: string,
    roots: ReadonlyArray<string>,
    outside: Parameters<NonNullable<HostFileReads["part"]>>[2],
    first: { readonly size: number; readonly mtime: number },
  ) =>
  (to: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (first.size > OBJECT_MAX_BYTES) return false;
      let offset = 0;
      yield* Effect.promise(() => appendFile(to, Buffer.alloc(0)));
      while (offset < first.size) {
        const length = Math.min(HOST_FILE_PART_BYTES, first.size - offset);
        const got = yield* part(path, roots, outside, offset, length).pipe(
          Effect.timeoutOption(HOST_PART_TIMEOUT),
        );
        if (got._tag === "None") return false;
        if (got.value.size !== first.size || got.value.mtime !== first.mtime) return false;
        if (got.value.data.length > Math.ceil(length / 3) * 4) return false;
        const bytes = Buffer.from(got.value.data, "base64");
        if (bytes.length !== length) return false;
        yield* Effect.promise(() => appendFile(to, bytes));
        offset += bytes.length;
      }
      return true;
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

export class WorkspaceOutputs extends Context.Service<WorkspaceOutputs, WorkspaceOutputsShape>()(
  "@gram/server/WorkspaceOutputs",
) {
  static readonly layer: Layer.Layer<
    WorkspaceOutputs,
    never,
    EventHub | ThreadStore | ThreadRuntimes | ServerConfig | SqlClient.SqlClient
  > = Layer.effect(
    WorkspaceOutputs,
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const config = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const attachments = attachmentsDir(config.dataDir);
      const objects = yield* ObjectStore;
      const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));

      const admit = (thread: Thread, output: ObservedOutput) =>
        Effect.promise(async (): Promise<Checked | undefined> => {
          if (thread.role === "dream") return undefined;
          const spelled = expandHome(output.path.trim());
          const path = isAbsolute(spelled)
            ? resolve(spelled)
            : resolve(effectiveCheckout(thread).path, spelled);
          if (isCredentialPath(path)) return undefined;
          const own = join(attachments, thread.id);
          const otherAttachment = (base: string, at: string) =>
            isInside(base, at) && !isInside(join(base, thread.id), at);
          if (otherAttachment(attachments, path)) return undefined;
          const here = sessionHostOf(thread) === LOCAL_HOST_ID;
          const roots = here
            ? [
                ...new Set([
                  thread.checkout.path,
                  ...checkoutRoots(thread),
                  ...(thread.additionalDirectories ?? []),
                  own,
                ]),
              ]
            : [own];
          const realRoots = await Promise.all(roots.map(realOr));
          const inside = [...roots.map((root) => resolve(root)), ...realRoots].some((root) =>
            isInside(root, path),
          );
          if (!inside && (!here || (output.source !== "sent" && output.source !== "written")))
            return undefined;
          const checked = await checkFile(path, roots, !inside);
          if (checked === undefined || isCredentialPath(checked.real)) return undefined;
          if (otherAttachment(await realOr(attachments), checked.real)) return undefined;
          return checked;
        });

      const keep = (thread: Thread, source: OutputSource, checked: Omit<Checked, "real">) =>
        Effect.gen(function* () {
          const threadId = thread.id;
          const kind = outputKindOf(checked.path, source);
          const mediaType = outputMediaType(checked.path);
          const known = yield* run(
            sql<{ kind: string; source: string; size: number; mtime: number }>`SELECT kind, source,
                size, mtime FROM thread_outputs WHERE thread_id = ${threadId} AND path = ${checked.path}`,
          );
          const same = known[0];
          if (
            same !== undefined &&
            same.kind === kind &&
            same.source === source &&
            same.size === checked.size &&
            same.mtime === checked.mtime
          )
            return false;
          const at = yield* Clock.currentTimeMillis;
          yield* run(
            sql`INSERT INTO thread_outputs
                (thread_id, path, kind, source, media_type, size, mtime, at)
              VALUES (${threadId}, ${checked.path}, ${kind}, ${source}, ${mediaType},
                ${checked.size}, ${checked.mtime}, ${at})
              ON CONFLICT(thread_id, path) DO UPDATE SET kind = excluded.kind,
                source = excluded.source, media_type = excluded.media_type,
                size = excluded.size, mtime = excluded.mtime, at = excluded.at`,
          );
          return true;
        });

      const changed = (thread: Thread) =>
        thread.workspaceId === undefined
          ? Effect.void
          : hub.publish({ type: "outputs.changed", workspaceId: thread.workspaceId });

      const recordElsewhere = (thread: Thread, output: ObservedOutput) =>
        Effect.gen(function* () {
          if (hosts === undefined || thread.role === "dream" || !(yield* objects.on)) return;
          const checkout = effectiveCheckout(thread);
          const spelled = output.path.trim();
          if (spelled === "" || isCredentialPath(spelled)) return;
          const host = yield* hosts.get(hostOf(checkout)).pipe(Effect.option);
          const part = host._tag === "None" ? undefined : host.value.reads?.part;
          if (part === undefined) return;
          const roots = [
            ...new Set([
              checkout.path,
              thread.checkout.path,
              ...checkoutRoots(thread),
              ...(thread.additionalDirectories ?? []),
            ]),
          ];
          const outside = {
            allowed: output.source === "sent" || output.source === "written",
            refusal: "isn't in this thread's folders",
          };
          const first = Option.flatten(
            yield* part(spelled, roots, outside, 0, 1).pipe(
              Effect.timeoutOption(HOST_PART_TIMEOUT),
              Effect.option,
            ),
          );
          if (first._tag === "None" || isCredentialPath(first.value.path)) return;
          const { path, size, mtime } = first.value;
          if (size < 0 || path.length > HOST_PATH_MAX) return;
          const fresh = yield* keep(thread, output.source, { path, size, mtime });
          yield* objects.putStaged(
            outputKey(thread.id, path),
            `${size}:${mtime}`,
            stageFrom(part, path, roots, outside, { size, mtime }),
          );
          if (fresh) yield* changed(thread);
        });

      const recordNow = (threadId: ThreadId, output: ObservedOutput) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId).pipe(Effect.option);
          if (thread._tag === "None") return;
          const checked = yield* admit(thread.value, output);
          if (checked === undefined) {
            if (!isLocalHost(effectiveCheckout(thread.value)))
              yield* recordElsewhere(thread.value, output);
            return;
          }
          if (!(yield* keep(thread.value, output.source, checked))) return;
          if (!isInside(attachments, checked.path)) {
            yield* objects.put(outputKey(threadId, checked.path), checked.real);
          }
          yield* changed(thread.value);
        });

      const pending = yield* Queue.unbounded<readonly [ThreadId, ObservedOutput]>();
      yield* Queue.take(pending).pipe(
        Effect.flatMap(([threadId, output]) =>
          recordNow(threadId, output).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("couldn't record a thread's output").pipe(
                Effect.annotateLogs({ threadId, cause: String(cause) }),
              ),
            ),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* runtimes.observe({
        onOutput: (threadId, output) =>
          Queue.offer(pending, [threadId, output]).pipe(Effect.asVoid),
      });

      const list: WorkspaceOutputsShape["list"] = (workspaceId, query = {}) =>
        Effect.gen(function* () {
          const after = query.cursor === undefined ? undefined : parseCursor(query.cursor);
          if (query.cursor !== undefined && after === undefined) {
            return yield* new InvalidState({ message: "That isn't a page of this list" });
          }
          const limit = Math.min(query.limit ?? OUTPUTS_PAGE, OUTPUTS_PAGE_MAX);
          const kind = query.kind ?? null;
          const afterAt = after?.at ?? null;
          const afterSeq = after?.seq ?? null;
          const rows = yield* run(
            sql<Row>`SELECT o.seq, o.thread_id, o.path, o.kind, o.source, o.media_type, o.size, o.at,
                json_extract(t.data, '$.title') AS title,
                json_extract(t.data, '$.role') AS role,
                json_extract(t.data, '$.spawnedBy.feature') AS feature
              FROM thread_outputs o JOIN threads t ON t.id = o.thread_id
              WHERE json_valid(t.data)
                AND json_extract(t.data, '$.workspaceId') = ${workspaceId}
                AND coalesce(json_extract(t.data, '$.role'), '') <> 'dream'
                AND (${kind} IS NULL OR o.kind = ${kind})
                AND (${afterAt} IS NULL OR o.at < ${afterAt}
                  OR (o.at = ${afterAt} AND o.seq < ${afterSeq}))
              ORDER BY o.at DESC, o.seq DESC
              LIMIT ${limit + 1}`,
          );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          return {
            outputs: page.flatMap(toOutput),
            ...(rows.length > limit && last !== undefined
              ? { next: cursorOf(last.at, last.seq) }
              : {}),
          };
        });

      return WorkspaceOutputs.of({
        record: (threadId, output) => recordNow(threadId, output),
        list,
      });
    }),
  );
}
