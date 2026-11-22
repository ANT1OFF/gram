import {
  type Attachment,
  InvalidState,
  MAX_ATTACHMENT_BYTES,
  THREAD_MESSAGE_ATTACHMENTS_BYTES_MAX,
  THREAD_MESSAGE_ATTACHMENTS_MAX,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeAttachmentName } from "../attachments/attachments.ts";

/** The largest body `/embed/v1/thread-messages` takes: its files as base64, and room for the rest. */
export const THREAD_MESSAGE_BODY_MAX =
  Math.ceil((THREAD_MESSAGE_ATTACHMENTS_BYTES_MAX * 4) / 3) + 256 * 1024;

/** A file a host sent with a message, decoded. */
export interface GivenAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
}

const NAME_MAX = 200;
const MEDIA_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const hasControl = (text: string): boolean => /\p{Cc}/u.test(text);
const megabytes = (bytes: number) => Math.round(bytes / 2 ** 20);

/**
 * The files a host's message carries (`attachments`), decoded, or why they can't be taken. The
 * host decides which kinds of file it sends; this holds them to a count and a size.
 */
export const attachmentsOf = (value: unknown): ReadonlyArray<GivenAttachment> | string => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "`attachments` is a list of `{ name, mediaType, data }`";
  if (value.length > THREAD_MESSAGE_ATTACHMENTS_MAX)
    return `a message carries at most ${THREAD_MESSAGE_ATTACHMENTS_MAX} attachments`;
  const given: Array<GivenAttachment> = [];
  let total = 0;
  for (const [index, each] of value.entries()) {
    const at = `\`attachments[${index}]\``;
    if (typeof each !== "object" || each === null || Array.isArray(each))
      return `${at} is \`{ name, mediaType, data }\``;
    const { name, mediaType, data, ...rest } = each as Record<string, unknown>;
    if (Object.keys(rest).length > 0)
      return `${at} takes only \`name\`, \`mediaType\` and \`data\``;
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name.length > NAME_MAX ||
      hasControl(name)
    )
      return `${at}.name is 1 to ${NAME_MAX} printable characters`;
    if (typeof mediaType !== "string" || !MEDIA_TYPE.test(mediaType))
      return `${at}.mediaType is a media type, such as \`image/png\``;
    if (typeof data !== "string" || !BASE64.test(data) || data.length % 4 !== 0)
      return `${at}.data is the file's bytes in base64`;
    if (Math.floor((data.length * 3) / 4) > MAX_ATTACHMENT_BYTES + 2)
      return `${name} is over the ${megabytes(MAX_ATTACHMENT_BYTES)} MB an attachment may be`;
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return `${name} is empty`;
    if (bytes.length > MAX_ATTACHMENT_BYTES)
      return `${name} is over the ${megabytes(MAX_ATTACHMENT_BYTES)} MB an attachment may be`;
    total += bytes.length;
    if (total > THREAD_MESSAGE_ATTACHMENTS_BYTES_MAX)
      return `a message's attachments come to at most ${megabytes(THREAD_MESSAGE_ATTACHMENTS_BYTES_MAX)} MB`;
    given.push({
      name: name.trim(),
      mediaType: mediaType.toLowerCase(),
      bytes,
    });
  }
  return given;
};

/** A message's files as the agent is given them, and the write that puts them there. */
export interface PlannedAttachments {
  readonly attachments: ReadonlyArray<Attachment>;
  /**
   * Writes the files, each once: run inside the message's reserved delivery, so only a caller
   * allowed to write in the thread, sending this exact message, puts anything there.
   */
  readonly write: Effect.Effect<void, InvalidState>;
}

/**
 * Where a message's files go in its thread's attachments folder (`dir` is `<dataDir>/attachments`),
 * where an attachment a person uploads goes, so they are kept, carried to the machine the session
 * runs on and deleted with the thread alike. Each path holds the file's own digest, so a message
 * sent again under its key names the same paths only with the same bytes, and a file once written
 * is never replaced: different bytes under a used key are a different message, which the key's
 * receipt refuses.
 */
export const planMessageAttachments = (
  dir: string,
  threadId: ThreadId,
  key: string,
  given: ReadonlyArray<GivenAttachment>,
): PlannedAttachments => {
  const folder = join(dir, threadId, `message-${key}`);
  const files = given.map((each, index) => ({
    each,
    path: join(
      folder,
      `${index + 1}-${createHash("sha256").update(each.bytes).digest("hex").slice(0, 16)}-${sanitizeAttachmentName(each.name)}`,
    ),
  }));
  return {
    attachments: files.map(({ each, path }) => ({
      path,
      name: each.name,
      mediaType: each.mediaType,
    })),
    write:
      files.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: async () => {
              await mkdir(folder, { recursive: true });
              for (const { each, path } of files)
                await writeFile(path, each.bytes, { flag: "wx" }).catch((error: unknown) => {
                  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                });
            },
            catch: () =>
              new InvalidState({ message: "the message's attachments couldn't be stored" }),
          }),
  };
};
