import {
  type Attachment,
  MAX_ATTACHMENT_BYTES,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isInside, tryRealPath } from "@gram/git";
import { basename, join, resolve } from "node:path";
import { openOutside, readUpTo } from "../fs/files.ts";
import type { HostAttachments } from "./file-reads.ts";

/**
 * The machine's attachments store as a session there reaches it now, or why it can't: offline, or
 * a host whose build doesn't hold attachments.
 */
export type AttachmentsOnMachine = () => Effect.Effect<HostAttachments, string>;

const failure = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const readHere = (
  path: string,
  maxBytes: number,
  within: string | undefined,
): Effect.Effect<string, string> =>
  Effect.gen(function* () {
    const root =
      within === undefined
        ? undefined
        : ((yield* Effect.promise(() => tryRealPath(resolve(within)))) ?? false);
    const inside = (real: string) => root === undefined || (root !== false && isInside(root, real));
    const handle = yield* openOutside(path, {}, inside, { regularFile: true });
    const bytes = yield* Effect.tryPromise({
      try: () => readUpTo(handle, maxBytes + 1),
      catch: () => "it couldn't be read here",
    });
    if (bytes.length > maxBytes) {
      return yield* Effect.fail(
        `it is over the ${Math.max(1, Math.round(maxBytes / 2 ** 20))} MB attachment limit`,
      );
    }
    return bytes.toString("base64");
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      typeof error === "string"
        ? error
        : error._tag === "NotFound"
          ? "it is no longer where it was attached from"
          : /credentials/.test(error.message)
            ? "it may hold credentials, so it isn't sent"
            : /isn't where it may be read from/.test(error.message)
              ? "it isn't one of the files attached here"
              : "it couldn't be read here",
    ),
  );

const nameOf = (attachment: Attachment) => attachment.name ?? basename(attachment.path);

/**
 * `input` as a session on `machineName` reads it: each attachment, a file on this machine, copied
 * to the machine's own store for `threadId` and named there instead. An attachment that can't be
 * copied is left out, and the prompt says so, so the agent never reads a path of this machine's
 * (which on that one is missing, or another file) and can tell the user what didn't arrive.
 */
export const carryAttachments = (
  threadId: ThreadId,
  input: UserInput,
  machineName: string,
  store: AttachmentsOnMachine,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
  within?: string,
): Effect.Effect<UserInput> =>
  Effect.gen(function* () {
    const attached = input.attachments ?? [];
    if (attached.length === 0) return input;
    const target = yield* Effect.result(store());
    const carried: Array<Attachment> = [];
    const missed: Array<string> = [];
    for (const attachment of attached) {
      const name = nameOf(attachment);
      const copied =
        target._tag === "Failure"
          ? Result.fail(target.failure)
          : yield* readHere(
              attachment.path,
              maxBytes,
              within === undefined ? undefined : join(within, threadId),
            ).pipe(
              Effect.flatMap((data) =>
                target.success.put(threadId, name, data).pipe(Effect.mapError(failure)),
              ),
              Effect.result,
            );
      if (copied._tag === "Success") {
        carried.push({ ...attachment, path: copied.success.path });
      } else {
        missed.push(`${name} (${copied.failure})`);
        yield* Effect.logWarning("an attachment didn't reach the machine its session runs on").pipe(
          Effect.annotateLogs({ threadId, machine: machineName, reason: copied.failure }),
        );
      }
    }
    const note =
      missed.length === 0
        ? ""
        : `\n\n[Gram couldn't copy ${missed.length === 1 ? "this attachment" : "these attachments"} to ${machineName}, where this session runs: ${missed.join("; ")}. Tell the user it didn't arrive.]`;
    const { attachments: _, ...rest } = input;
    return {
      ...rest,
      text: `${input.text}${note}`,
      ...(carried.length === 0 ? {} : { attachments: carried }),
    };
  });
