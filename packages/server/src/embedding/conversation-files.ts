import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CONVERSATION_REPLY_FILES_MAX } from "@gram/contracts";
import { ServerConfig } from "../config.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";
import { readKeptReplyFile } from "./reply-files.ts";

const REPLY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `POST /embed/v1/conversation-files`: one file of a reply, for the host to post with it. `reply`
 * is the `id` `conversation.reply` carried, and `index` the file's place in its `files`.
 */
export const ConversationFilesInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const config = yield* ServerConfig;
    yield* inbound.route("POST", "conversation-files", (body) =>
      Effect.gen(function* () {
        const reply = body?.["reply"];
        const index = body?.["index"];
        if (typeof reply !== "string" || !REPLY_ID.test(reply))
          return refusal(400, "`reply` is a reply's id");
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= CONVERSATION_REPLY_FILES_MAX
        )
          return refusal(400, `\`index\` is 0 to ${CONVERSATION_REPLY_FILES_MAX - 1}`);
        const file = yield* readKeptReplyFile(config.dataDir, reply, index);
        if (file === undefined) return refusal(404, "this server keeps no such file");
        const { bytes, ...shown } = file;
        return answer({ ...shown, data: bytes.toString("base64") });
      }),
    );
  }),
);
