import type { Attachment } from "@gram/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { AttachmentTarget } from "@/api/types";
import { useThreadsStore } from "@/stores/threads";

import {
  type AttachmentAction,
  AttachmentDraft,
  threadAttachmentDraft,
  type AttachmentTransfer,
} from "./attachment-draft";
import { attachFile, type PendingAttachment } from "./attachments";

export interface Attachments {
  /** Whether this captured hook still belongs to the authoritative thread lifetime. */
  readonly active: boolean;
  readonly items: readonly PendingAttachment[];
  /** A file is still uploading: sending or creating waits. */
  readonly uploading: boolean;
  /** The attachments to send. */
  readonly ready: readonly Attachment[];
  /** Ready and in-flight references that discarding another stash must not delete. */
  readonly keep: readonly string[];
  /** Attaches pasted or dropped files; `false` when there were none. */
  add(files: FileList): boolean;
  remove(key: string): void;
  /** Drops the chips once their attachments have been sent. */
  clear(): void;
  /** Adds attachments that are already stored, e.g. from a restored stash, as ready chips. */
  adopt(attachments: readonly Attachment[]): void;
  /** Holds captured files for one RPC's consumption or rollback, across thread/pane remounts. */
  capture(): AttachmentTransfer;
  /** Starts one stash/restore per owner generation; a remount cannot duplicate the transaction. */
  claim(action: AttachmentAction): AttachmentTransfer | undefined;
}

/**
 * Existing thread drafts belong to that thread for this window's lifetime, until consumed,
 * removed or closed. New-thread/task drafts keep their local mount ownership and initial files.
 */
export function useAttachments(
  target: AttachmentTarget,
  initial: readonly Attachment[] = [],
): Attachments {
  const api = useApi();
  const threadId = "threadId" in target ? target.threadId : undefined;
  const draftId = "draftId" in target ? target.draftId : undefined;
  const createdAt = useThreadsStore((state) =>
    threadId === undefined ? undefined : state.byId[threadId]?.thread.createdAt,
  );
  const draft = useMemo(
    () => (threadId === undefined ? new AttachmentDraft(initial) : threadAttachmentDraft(threadId)),
    // `initial` seeds a new draft once; subsequent render arrays must not replace staged files.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [threadId, draftId, createdAt],
  );
  const { items, keep } = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);

  const add = (files: FileList) => {
    if (files.length === 0 || !draft.active) return false;
    for (const file of Array.from(files)) {
      const key = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      draft.add({
        key,
        name: file.name,
        status: "uploading",
        ...(previewUrl ? { previewUrl } : {}),
      });
      attachFile(api, target, file, (f) => window.gram?.getPathForFile(f)).then(
        (attachment) => draft.settle(key, { status: "ready", attachment }),
        (error: unknown) => draft.settle(key, { status: "failed", error: errorMessage(error) }),
      );
    }
    return true;
  };

  return {
    get active() {
      return draft.active;
    },
    items,
    keep,
    uploading: items.some((item) => item.status === "uploading"),
    ready: items.flatMap((item) =>
      item.status === "ready" && item.attachment ? [item.attachment] : [],
    ),
    add,
    remove: (key) => draft.remove(new Set([key])),
    clear: draft.clear,
    adopt: draft.adopt,
    capture: draft.capture,
    claim: draft.claim,
  };
}
