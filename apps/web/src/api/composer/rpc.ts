import { run, type RpcContext } from "../rpc-client";
import type { ComposerApi } from "./types";

/** `ComposerApi` over the RPC client. */
export const composerRpc = ({ client }: RpcContext): ComposerApi => ({
  paletteFilters: (threadId, query) => run(client["palette.filters"]({ threadId, query })),
  uploadAttachment: (target, file) => run(client["attachment.upload"]({ ...target, ...file })),
  readAttachment: (threadId, path) => run(client["attachment.read"]({ threadId, path })),
  promptHistory: async (threadId, limit) =>
    (
      await run(
        client["thread.promptHistory"](limit === undefined ? { threadId } : { threadId, limit }),
      )
    ).prompts,
  listStashes: async (threadId) => (await run(client["thread.stash.list"]({ threadId }))).stashes,
  stashDraft: (threadId, { id, text, attachments }) =>
    run(client["thread.stash.add"]({ id, threadId, text, attachments })),
  takeStash: (threadId, stashId) => run(client["thread.stash.take"]({ threadId, stashId })),
  removeStash: (threadId, stashId, keep = []) =>
    run(
      client["thread.stash.remove"]({
        threadId,
        stashId,
        ...(keep.length > 0 ? { keep: [...keep] } : {}),
      }),
    ),
  threadRecap: (threadId) => run(client["thread.recap"]({ threadId })),
  threadCatchUp: (threadId) => run(client["thread.catchUp"]({ threadId })),
  threadWhyStuck: (threadId) => run(client["thread.whyStuck"]({ threadId })),
  threadSuggestions: (threadId) => run(client["thread.suggestions"]({ threadId })),
  requestReplies: (threadId, requestId) => run(client["request.replies"]({ threadId, requestId })),
  requestNoticeTitle: (threadId, requestId, count) =>
    run(client["request.noticeTitle"]({ threadId, requestId, count })),
  recordHelperEvent: (event) => run(client["helper.recordEvent"](event)),
});
