import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { MessageId, GramUIMessage, ThreadId, ThreadStatus } from "@gram/contracts";
import { Copy, Ellipsis, FolderGit2, GitFork, History, Inbox, Pencil } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage, rewindErrorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatMessageStamp, formatMessageTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DrawnCheck, Swap } from "@/motion";
import { copyText } from "@/settings/copy-text";
import { useDraftStore } from "@/stores/drafts";
import { feedMessages } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { messageMarkdown, turnMarkdown, turnMessages } from "./copy-markdown";
import { ForkDialog } from "./fork-dialog";
import { useForkAvailability, useForkThread, WORKTREE_NOTICE } from "./use-fork";
import { useReadOnlyTranscript } from "./read-only-transcript";

/** A turn in progress: rewinding now would race the agent. */
const BUSY: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

const ACTION =
  "rounded-(--radius-sm) text-muted-foreground aria-disabled:opacity-50 [@media(pointer:coarse)]:size-9";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

export const messageText = (message: GramUIMessage): string =>
  message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/** The agent has reported its own ids for this reply, so it's a resume and fork point. */
const hasAgentIds = (message: GramUIMessage) =>
  (message.metadata?.agentMessageIds?.length ?? 0) > 0;

/** How long "Copied" stays before the button reads "Copy" again. */
export const COPIED_MS = 1500;

/** Copies `text`, telling the user in a toast when there's no button to show a checkmark. */
export async function copyMarkdown(text: string, options: { toast?: boolean } = {}) {
  try {
    await copyText(text);
    if (options.toast) {
      useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title: "Copied" });
    }
    return true;
  } catch (error) {
    useThreadsStore.getState().applyEvent({
      type: "notify",
      kind: "error",
      title: "Couldn't copy",
      body: errorMessage(error),
    });
    return false;
  }
}

/**
 * Copy, Add to Waiting on you, rewind / edit and, on replies, fork actions under a message, and
 * when it arrived, shown on hover or keyboard focus. `turnEnd`: the reply that ends a finished
 * turn, which can copy the whole turn.
 */
export function MessageActions({
  threadId,
  message,
  turnEnd = false,
}: {
  threadId: ThreadId;
  message: GramUIMessage;
  turnEnd?: boolean;
}) {
  // Another thread's message sits on the agents' side, so its actions do too.
  const isUser =
    message.role === "user" && !message.parts.some((part) => part.type === "data-thread-origin");
  const readOnly = useReadOnlyTranscript();
  if (readOnly) {
    return (
      <div
        data-testid="message-actions"
        className={cn(
          "flex flex-wrap items-center gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
          isUser ? "justify-end" : "justify-start",
        )}
      >
        {isUser && <SentAt message={message} />}
        <CopyAction
          testId="message-copy"
          label="Copy message"
          text={() => messageMarkdown(message)}
        />
        {!isUser && <SentAt message={message} />}
      </div>
    );
  }
  return (
    <div
      data-testid="message-actions"
      className={cn(
        "flex flex-wrap items-center gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-within:opacity-100 has-data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {/* On the side towards the conversation, so the buttons keep their place at the edge. */}
      {isUser && <SentAt message={message} />}
      <CopyAction
        testId="message-copy"
        label="Copy message"
        text={() => messageMarkdown(message)}
      />
      <WaitAction threadId={threadId} message={message} />
      <RewindAction threadId={threadId} message={message} />
      {message.role === "assistant" ? (
        <ForkActions threadId={threadId} message={message} turnEnd={turnEnd} />
      ) : turnEnd ? (
        <MoreActions>
          <TurnCopyAction threadId={threadId} message={message} />
        </MoreActions>
      ) : null}
      {!isUser && <SentAt message={message} />}
    </div>
  );
}

/**
 * When the message arrived, using notification dates, with the full date, seconds and zone's offset
 * in its hint. A message without a date shows none, rather than a guess.
 */
function SentAt({ message }: { message: GramUIMessage }) {
  const createdAt = message.metadata?.createdAt;
  if (createdAt === undefined) return null;
  return (
    <time
      data-testid="message-sent-at"
      dateTime={new Date(createdAt).toISOString()}
      title={formatMessageTime(createdAt)}
      className="px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums"
    >
      {formatMessageStamp(createdAt)}
    </time>
  );
}

/**
 * "Add to Waiting on you": keeps the message in the thread's tray, as a
 * draft whose Copy takes its quoted or fenced block, titled by its first line. Shown done while an
 * open item already points at it.
 */
function WaitAction({ threadId, message }: { threadId: ThreadId; message: GramUIMessage }) {
  const api = useApi();
  const kept = useThreadsStore(
    (s) => s.byId[threadId]?.waits?.some((item) => item.messageId === message.id) === true,
  );
  const [pending, setPending] = useState(false);
  const label = kept ? "Waiting on you" : "Add to Waiting on you";
  const add = async () => {
    setPending(true);
    try {
      await api.addWait(threadId, message.id as MessageId);
    } catch (error) {
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "error",
        title: "Couldn't add it to Waiting on you",
        body: errorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };
  const disabledReason = kept ? "Already added" : pending ? "Adding message…" : undefined;
  return (
    <Hint
      label={disabledReason ? `${label}\n${disabledReason}` : label}
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="message-wait"
          aria-label={label}
          aria-description={disabledReason}
          disabled={kept || pending}
          focusableWhenDisabled
          onClick={() => void add()}
          className={ACTION}
        />
      }
    >
      <Inbox aria-hidden className={cn("size-3.5", kept && "text-status-needs")} />
    </Hint>
  );
}

/** Primary message copy, or a secondary menu item with the same copy feedback. */
function CopyAction({
  testId,
  label,
  text,
  menu = false,
}: {
  testId: string;
  label: string;
  text: () => string;
  menu?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const shown = copied ? "Copied" : label;
  const copy = () => void copyMarkdown(text()).then((ok) => setCopied(ok));
  const content = (
    <>
      <Swap swapKey={copied ? "copied" : "copy"}>
        {copied ? (
          <DrawnCheck className="size-3.5 text-success" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
      </Swap>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
  if (menu) {
    return (
      <Menu.Item
        data-testid={testId}
        aria-label={shown}
        aria-description="Prompt and replies as Markdown"
        label={label}
        onClick={copy}
        closeOnClick={false}
        className={MENU_ITEM}
      >
        {content}
        <span>
          <span className="block">{shown}</span>
          <span className="block text-xs text-muted-foreground">
            Prompt and replies as Markdown
          </span>
        </span>
      </Menu.Item>
    );
  }
  return (
    <Hint
      label={copied ? "Copied" : "Copy message\nThis message as Markdown"}
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid={testId}
          aria-label={shown}
          aria-description="This message as Markdown"
          onClick={copy}
          className={ACTION}
        />
      }
    >
      {content}
    </Hint>
  );
}

/** Rewinding with files to a message that has no checkpoint, e.g. one copied into a fork. */
const rewindFailure = (error: unknown) =>
  errorMessage(error).includes("no checkpoint")
    ? "Files can't be restored to this message. Rewind without “Restore files too”."
    : rewindErrorMessage(error);

/**
 * "Rewind to here" (assistant) or "Edit from here" (user), confirmed in a popover with an optional
 * "Restore files too". Hidden when the agent can't rewind; disabled while a turn runs.
 */
function RewindAction({ threadId, message }: { threadId: ThreadId; message: GramUIMessage }) {
  const api = useApi();
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const rewindSupport = useThreadsStore((s) => s.byId[threadId]?.capabilities?.rewind);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  // Capabilities reach the store with the next snapshot, not with `thread.upsert`, so a thread created
  // this session has none yet. Offer history only until we know files can be restored too.
  const support = rewindSupport ?? "history";
  if (support === "none") return null;

  const isUser = message.role === "user";
  const label = isUser ? "Edit from here" : "Rewind to here";
  const busy = status !== undefined && BUSY.has(status);
  // User targets resume from the reply before them, which the server resolves.
  const disabledReason = busy
    ? "Wait for the turn to finish"
    : isUser || hasAgentIds(message)
      ? undefined
      : "This reply can't be rewound to yet";
  const restoreFiles = support === "historyAndFiles" && files;
  const messageId = message.id as MessageId;

  const confirm = async () => {
    if (isUser) {
      useDraftStore.getState().startEdit(threadId, messageText(message), {
        messageId,
        files: restoreFiles,
      });
      setOpen(false);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await api.rewind(threadId, messageId, restoreFiles);
      setOpen(false);
    } catch (e) {
      setError(rewindFailure(e));
    } finally {
      setPending(false);
    }
  };

  const Icon = isUser ? Pencil : History;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(undefined);
      }}
    >
      <Hint
        label={
          disabledReason
            ? `${label}\n${disabledReason}`
            : `${label}\n${isUser ? "Edit this message and replace the conversation after it" : "Remove the conversation after this reply"}`
        }
        render={
          <Popover.Trigger
            render={<Button variant="ghost" size="icon-sm" focusableWhenDisabled />}
            disabled={disabledReason !== undefined}
            data-testid={isUser ? "message-edit" : "message-rewind"}
            aria-label={label}
            aria-description={disabledReason}
            className={ACTION}
          />
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </Hint>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={isUser ? "end" : "start"} sideOffset={4}>
          <Popover.Popup
            data-testid="rewind-confirm"
            className="z-50 flex w-64 flex-col gap-2 rounded-(--radius-lg) border border-border bg-popover p-3 text-sm text-popover-foreground shadow-(--shadow-raised) transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Popover.Title className="font-medium">
              {isUser ? "Edit this message?" : "Rewind to this reply?"}
            </Popover.Title>
            <Popover.Description className="text-xs text-muted-foreground">
              {isUser
                ? "The composer is filled with it; sending removes it and everything after."
                : "Everything after this reply is removed from the conversation."}
            </Popover.Description>
            {support === "historyAndFiles" && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={files}
                  onChange={(event) => setFiles(event.target.checked)}
                />
                Restore files too
              </label>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Popover.Close className="rounded-(--radius-sm) px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                Cancel
              </Popover.Close>
              <Button size="xs" disabled={pending || busy} onClick={() => void confirm()}>
                {isUser ? "Edit" : "Rewind"}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * "Fork from here" and "Fork into worktree…" on a reply; disabled with a tooltip while forking isn't
 * possible. A refused fork into the source checkout continues in the worktree dialog.
 */
function ForkActions({
  threadId,
  message,
  turnEnd,
}: {
  threadId: ThreadId;
  message: GramUIMessage;
  turnEnd: boolean;
}) {
  const { available, reason } = useForkAvailability(threadId);
  const { fork, pending, error } = useForkThread(threadId);
  const [dialog, setDialog] = useState<{ notice?: string }>();
  const disabledReason =
    reason ?? (hasAgentIds(message) ? undefined : "This reply can't be forked from yet");
  const messageId = message.id as MessageId;

  const forkHere = async () => {
    const result = await fork({ fromMessageId: messageId });
    if (result === "needsWorktree") setDialog({ notice: WORKTREE_NOTICE });
  };

  const forkReason = disabledReason ?? (pending ? "Forking thread…" : undefined);
  return (
    <>
      <Hint
        label={
          forkReason
            ? `Fork from here\n${forkReason}`
            : "Fork from here\nStart a new thread with the conversation up to this reply"
        }
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="message-fork"
            aria-label="Fork from here"
            aria-description={forkReason}
            disabled={!available || disabledReason !== undefined || pending}
            focusableWhenDisabled
            onClick={() => void forkHere()}
            className={ACTION}
          />
        }
      >
        <GitFork aria-hidden className="size-3.5" />
      </Hint>
      <MoreActions>
        {turnEnd && <TurnCopyAction threadId={threadId} message={message} />}
        <Menu.Item
          data-testid="message-fork-worktree"
          aria-label="Fork into worktree…"
          aria-description={disabledReason ?? "Continue from this reply in a new worktree"}
          disabled={!available || disabledReason !== undefined}
          onClick={() => setDialog({})}
          className={MENU_ITEM}
        >
          <FolderGit2 aria-hidden className="size-3.5" />
          <span>
            <span className="block">Fork into worktree…</span>
            <span className="block text-xs text-muted-foreground">
              {disabledReason ?? "Continue from this reply in a new worktree"}
            </span>
          </span>
        </Menu.Item>
      </MoreActions>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {dialog && (
        <ForkDialog
          threadId={threadId}
          fromMessageId={messageId}
          notice={dialog.notice}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(undefined);
          }}
        />
      )}
    </>
  );
}

/** Rare actions keep their descriptions in a compact menu, including on touch screens. */
function MoreActions({ children }: { children: ReactNode }) {
  return (
    <Menu.Root>
      <Hint
        label="More message actions"
        render={
          <Menu.Trigger
            render={<Button variant="ghost" size="icon-sm" />}
            data-testid="message-more"
            aria-label="More message actions"
            className={ACTION}
          />
        }
      >
        <Ellipsis aria-hidden className="size-3.5" />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup className="min-w-56 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TurnCopyAction({ threadId, message }: { threadId: ThreadId; message: GramUIMessage }) {
  return (
    <CopyAction
      testId="turn-copy"
      label="Copy turn"
      text={() => turnMarkdown(turnMessages(feedMessages(threadId), message.id))}
      menu
    />
  );
}
