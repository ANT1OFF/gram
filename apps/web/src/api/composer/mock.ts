import {
  helperOn,
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_THREADS,
  promptsFromMessages,
  type Attachment,
  type RequestId,
  type ThreadId,
  type ThreadSuggestions,
  type TurnId,
  type UserInput,
} from "@gram/contracts";

import { createMockAssist } from "../mock-assist";
import { MOCK_TOOL_IMAGE, readMockAttachment } from "../mock-files";
import { mockOutputImage } from "../mock-outputs";
import { createMockStashes } from "../mock-stashes";
import type { MockWorld } from "../mock-world";
import type { ComposerApi } from "./types";

/**
 * Attachments, stashed drafts, prompt history, recaps and suggested replies. The core builds it,
 * because its turns end with suggestions, a new thread adopts a draft's uploads, and its controls
 * script a recap; `api` is what joins the `Api`.
 */
export function createComposerMock(world: MockWorld, persist: boolean) {
  /** Uploaded bytes by path, so `readAttachment` can serve back what was pasted or dropped. */
  const uploads = new Map<string, string>();
  const stashes = createMockStashes(persist);
  const assist = createMockAssist();
  /** Replies armed by `simulateSuggestions`, sent when the thread's next turn ends. */
  const armed = new Map<ThreadId, readonly string[]>();
  /** The last suggestions sent for each thread, as the server's memo. */
  const suggested = new Map<ThreadId, ThreadSuggestions>();
  /** Replies the helper "drafts" for a free-form question, armed by `armAskReplies`. */
  const askReplies = new Map<RequestId, readonly string[]>();
  /** Titles the helper "suggests" for a request's notification, armed by `armNoticeTitle`. */
  const noticeTitles = new Map<RequestId, string>();

  const api: ComposerApi = {
    paletteFilters: async () => [],
    uploadAttachment: async (target, file) => {
      if ("threadId" in target) world.summary(target.threadId);
      const folder = "threadId" in target ? target.threadId : `_drafts/${target.draftId}`;
      const attachment: Attachment = {
        path: `/mock/attachments/${folder}/${file.name}`,
        name: file.name,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      };
      uploads.set(attachment.path, file.data);
      return attachment;
    },
    readAttachment: async (threadId, path) => {
      await world.delay(20);
      // The page folds the same chunks on its own, and can ask for a part's file before this fold
      // has caught up with it.
      await world.settled(threadId);
      // A stored tool image or sent file the Files view lists, drawn for its thread.
      const made = mockOutputImage(world, threadId, path, "attachment");
      if (made !== undefined) return made;
      const referenced = world
        .messages(threadId)
        .some((message) =>
          message.parts.some(
            (part) =>
              (part.type === "file" && part.url === `file://${path}`) ||
              (part.type === "data-tool-image" && part.data.path === path),
          ),
        );
      if (!referenced) {
        throw Object.assign(new Error("That file isn't attached to this thread"), {
          _tag: "InvalidState",
        });
      }
      const stored = path === MOCK_TOOL_IMAGE.path ? MOCK_TOOL_IMAGE.base64 : undefined;
      return readMockAttachment(path, uploads.get(path) ?? stored);
    },
    promptHistory: async (threadId, limit = PROMPT_HISTORY_LIMIT) => {
      const current = world.summary(threadId).thread;
      const others = world
        .threads()
        .map((summary) => summary.thread)
        .filter((t) => t.id !== threadId && t.projectId === current.projectId)
        .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, PROMPT_HISTORY_THREADS);
      const transcripts = [current, ...others].map((t) => world.messages(t.id));
      return promptsFromMessages(transcripts, Math.min(limit, PROMPT_HISTORY_LIMIT));
    },
    listStashes: async (threadId) => {
      world.summary(threadId);
      return stashes.list(threadId);
    },
    stashDraft: async (threadId, { id, text, attachments }) => {
      world.summary(threadId);
      await world.delay(10);
      return stashes.add(threadId, text, attachments, id);
    },
    takeStash: async (threadId, stashId) => {
      world.summary(threadId);
      await world.delay(10);
      return stashes.take(threadId, stashId);
    },
    removeStash: async (threadId, stashId) => {
      world.summary(threadId);
      await world.delay(10);
      stashes.take(threadId, stashId);
    },
    threadRecap: async (threadId) => assist.recap(world.summary(threadId)),
    threadCatchUp: async (threadId) => assist.catchUp(world.summary(threadId)),
    threadWhyStuck: async (threadId) =>
      assist.whyStuck(world.summary(threadId), helperOn(await world.settings(), "stuck")),
    threadSuggestions: async (threadId) =>
      world.summary(threadId).status === "idle" ? (suggested.get(threadId) ?? null) : null,
    requestReplies: async (threadId, requestId) => {
      world.summary(threadId);
      await world.delay(30);
      // The server's switch: Suggested replies off, or every helper off, makes none.
      return helperOn(await world.settings(), "suggest") ? (askReplies.get(requestId) ?? []) : [];
    },
    requestNoticeTitle: async (threadId, requestId) => {
      world.summary(threadId);
      await world.delay(30);
      // The server's switch: Notification titles off, or every helper off, makes none.
      return helperOn(await world.settings(), "notice")
        ? (noticeTitles.get(requestId) ?? null)
        : null;
    },
    recordHelperEvent: async (event) => {
      assist.record(event);
    },
  };

  return {
    api,
    /** Follows a draft's uploaded bytes to the thread paths a new thread moved them to. */
    moveUploads(before: UserInput["attachments"], after: UserInput["attachments"]) {
      before?.forEach((attachment, index) => {
        const to = after?.[index]?.path;
        const bytes = uploads.get(attachment.path);
        if (to === undefined || to === attachment.path || bytes === undefined) return;
        uploads.delete(attachment.path);
        uploads.set(to, bytes);
      });
    },
    /** Sends the replies armed for `threadId` as its turn's suggestions. */
    suggest(threadId: ThreadId) {
      const replies = armed.get(threadId);
      if (replies === undefined) return;
      const suggestions = { threadId, turnId: world.ids() as TurnId, replies };
      suggested.set(threadId, suggestions);
      world.emit({ type: "thread.suggestions", ...suggestions });
    },
    /** What `requestNoticeTitle` answers for `requestId` while helpers are on. */
    armNoticeTitle(requestId: RequestId, title: string) {
      noticeTitles.set(requestId, title);
    },
    /** What `requestReplies` answers for `requestId` while helpers are on. */
    armAskReplies(requestId: RequestId, replies: readonly string[]) {
      askReplies.set(requestId, replies);
    },
    /** Arms `replies` for every turn of `threadId` that ends from now on. */
    armSuggestions(threadId: ThreadId, replies: readonly string[]) {
      armed.set(threadId, replies);
    },
    /** The recap helper, which `simulateRecap` scripts and `helperEvents` reads. */
    assist,
  };
}
