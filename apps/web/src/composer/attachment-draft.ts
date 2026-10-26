import type { Attachment, ThreadId } from "@gram/contracts";

import { useThreadsStore } from "@/stores/threads";

import type { PendingAttachment } from "./attachments";

const readyItem = (attachment: Attachment): PendingAttachment => ({
  key: crypto.randomUUID(),
  name: attachment.name ?? attachment.path.split(/[\\/]/).at(-1) ?? attachment.path,
  status: "ready",
  attachment,
});

/** A captured request keeps its previews until success or rollback, including across remounts. */
export interface AttachmentTransfer {
  readonly active: boolean;
  readonly uploading: boolean;
  readonly ready: readonly Attachment[];
  consume(): void;
  restore(): boolean;
  release(): void;
}
export type AttachmentAction = "stash" | "restore";
interface AttachmentSnapshot {
  readonly items: readonly PendingAttachment[];
  readonly keep: readonly string[];
}

/** Current-session ownership only: no File, object URL or attachment path enters Web Storage. */
export class AttachmentDraft {
  #items: readonly PendingAttachment[];
  #snapshot: AttachmentSnapshot;
  #listeners = new Set<() => void>();
  #held = new Map<string, { item: PendingAttachment; count: number }>();
  #leases = 0;
  #closed = false;
  #idleScheduled = false;
  #actions = new Map<AttachmentAction, AttachmentTransfer>();
  readonly #retained: () => boolean;
  readonly #onIdle: () => void;

  constructor(
    initial: readonly Attachment[] = [],
    retained: () => boolean = () => false,
    onIdle: () => void = () => {},
  ) {
    this.#items = initial.map(readyItem);
    this.#snapshot = { items: this.#items, keep: initial.map((attachment) => attachment.path) };
    this.#retained = retained;
    this.#onIdle = onIdle;
  }

  get active(): boolean {
    return !this.#closed;
  }

  snapshot = (): AttachmentSnapshot => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.#idle();
    };
  };

  #idle() {
    if (this.#idleScheduled) return;
    this.#idleScheduled = true;
    // Strict Mode unsubscribes and resubscribes in the same task; that is not an owner ending.
    queueMicrotask(() => {
      this.#idleScheduled = false;
      if (this.#closed || this.#listeners.size > 0 || this.#leases > 0) return;
      if (this.#retained() && this.#items.length > 0) return;
      this.dispose();
      this.#onIdle();
    });
  }

  #set(items: readonly PendingAttachment[]) {
    if (this.#closed || items === this.#items) return;
    this.#items = items;
    this.#publish();
    this.#idle();
  }

  #publish() {
    const referenced = [...this.#items, ...Array.from(this.#held.values(), (held) => held.item)];
    this.#snapshot = {
      items: this.#items,
      keep: Array.from(
        new Set(referenced.flatMap((item) => (item.attachment ? [item.attachment.path] : []))),
      ),
    };
    for (const listener of this.#listeners) listener();
  }

  add = (item: PendingAttachment) => this.#set([...this.#items, item]);
  adopt = (attachments: readonly Attachment[]) => {
    if (attachments.length > 0) this.#set([...this.#items, ...attachments.map(readyItem)]);
  };
  settle = (key: string, next: Partial<PendingAttachment>) => {
    // Removed/consumed uploads never reappear, even if their promise settles after a remount.
    if (!this.#items.some((item) => item.key === key)) return;
    this.#set(this.#items.map((item) => (item.key === key ? { ...item, ...next } : item)));
  };
  remove = (keys: ReadonlySet<string>) => {
    for (const item of this.#items) {
      if (keys.has(item.key) && item.previewUrl && !this.#held.has(item.key))
        URL.revokeObjectURL(item.previewUrl);
    }
    this.#set(this.#items.filter((item) => !keys.has(item.key)));
  };
  clear = () => this.remove(new Set(this.#items.map((item) => item.key)));

  /** Exclusion belongs to this owner generation, so closing/reopening cannot inherit an old lock. */
  claim = (action: AttachmentAction): AttachmentTransfer | undefined => {
    if (this.#closed || this.#actions.has(action)) return undefined;
    const transfer = this.capture();
    this.#actions.set(action, transfer);
    const release = transfer.release;
    transfer.release = () => {
      if (this.#actions.get(action) === transfer) this.#actions.delete(action);
      release();
    };
    return transfer;
  };

  capture = (): AttachmentTransfer => {
    const items = this.#items.filter((item) => item.status === "ready" && item.attachment);
    const keys = new Set(items.map((item) => item.key));
    this.#leases++;
    for (const item of items) {
      const held = this.#held.get(item.key);
      this.#held.set(item.key, { item, count: (held?.count ?? 0) + 1 });
    }
    this.#publish();
    const active = () => !this.#closed;
    let released = false;
    return {
      get active() {
        return !released && active();
      },
      uploading: this.#items.some((item) => item.status === "uploading"),
      ready: items.flatMap((item) => (item.attachment ? [item.attachment] : [])),
      consume: () => {
        if (!released) this.remove(keys);
      },
      restore: () => {
        if (released || this.#closed) return false;
        const existing = new Set(this.#items.map((item) => item.key));
        this.#set([...this.#items, ...items.filter((item) => !existing.has(item.key))]);
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#closed) return;
        this.#leases--;
        for (const item of items) {
          const held = this.#held.get(item.key)!;
          if (held.count > 1) this.#held.set(item.key, { item, count: held.count - 1 });
          else {
            this.#held.delete(item.key);
            if (item.previewUrl && !this.#items.some((current) => current.key === item.key))
              URL.revokeObjectURL(item.previewUrl);
          }
        }
        this.#publish();
        this.#idle();
      },
    };
  };

  dispose = () => {
    if (this.#closed) return;
    this.#closed = true;
    const urls = new Set(
      [...this.#items, ...Array.from(this.#held.values(), (held) => held.item)].flatMap((item) =>
        item.previewUrl ? [item.previewUrl] : [],
      ),
    );
    for (const url of urls) URL.revokeObjectURL(url);
    this.#held.clear();
    this.#actions.clear();
    this.#items = [];
    this.#publish();
  };
}

const threadDrafts = new Map<ThreadId, { createdAt: number | undefined; draft: AttachmentDraft }>();
// A reconnect may reveal a close/reopen without delivering a removal: the id survives, the
// authoritative createdAt does not. Ordinary snapshots and pane changes retain the same lifetime.
useThreadsStore.subscribe((current, previous) => {
  if (current.byId === previous.byId) return;
  for (const [threadId, { createdAt, draft }] of threadDrafts) {
    const thread = current.byId[threadId]?.thread;
    if (thread === undefined || thread.createdAt !== createdAt) {
      threadDrafts.delete(threadId);
      draft.dispose();
    }
  }
});

export function threadAttachmentDraft(threadId: ThreadId): AttachmentDraft {
  const createdAt = useThreadsStore.getState().byId[threadId]?.thread.createdAt;
  let entry = threadDrafts.get(threadId);
  if (entry !== undefined && entry.createdAt !== createdAt) {
    threadDrafts.delete(threadId);
    entry.draft.dispose();
    entry = undefined;
  }
  if (entry === undefined) {
    const owner = new AttachmentDraft(
      [],
      () => {
        const thread = useThreadsStore.getState().byId[threadId]?.thread;
        return thread !== undefined && thread.createdAt === createdAt;
      },
      () => {
        if (threadDrafts.get(threadId)?.draft === owner) threadDrafts.delete(threadId);
      },
    );
    entry = { createdAt, draft: owner };
    threadDrafts.set(threadId, entry);
  }
  return entry.draft;
}
