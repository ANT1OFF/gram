import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { MessageId, GramUIMessage, ThreadId, ThreadStatus } from "@gram/contracts";
import { Copy, Ellipsis, FolderGit2, GitFork, History, Inbox, Pencil } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

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
import { ReplyTokens } from "./reply-tokens";
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
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:row-cursor";

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

/** Under the message, in its own row: the default, where a transcript is read turn by turn. */
const IN_FLOW =
  "-mt-1 flex flex-wrap items-center gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-within:opacity-100 has-data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * On a raised strip over the message, taking no room of its own: the orchestrator's chat, where a
 * reserved row under every message would set its replies further from what follows than an update
 * is from them, and the rhythm would be uneven. Only where `float-actions` holds (a pointer that
 * hovers, a message at least 40 rem wide, its `@container/message`); on touch or in a narrow
 * column the strip is the in-flow row, always shown on touch. The message is positioned.
 */
const FLOATING =
  "float-actions:absolute float-actions:z-10 float-actions:mt-0 float-actions:flex-nowrap float-actions:whitespace-nowrap float-actions:rounded-(--radius-sm) float-actions:border float-actions:border-edge float-actions:bg-popover float-actions:p-0.5 float-actions:shadow-overlay";

/** A reply's strip sits at its end, over the last line's end; a user's beside its bubble's top. */
const FLOAT_REPLY = "float-actions:right-0 float-actions:bottom-0";
const FLOAT_USER = "float-actions:top-0 float-actions:right-full float-actions:mr-2";

/**
 * Copy and one "…" under a message, when it arrived and, on the reply that ends a turn, the tokens
 * the turn used (`ReplyTokens`), shown on hover or keyboard focus. The "…"
 * holds the rest, each named with a line on what it does or why it can't now: Copy turn (`turnEnd`:
 * the reply that ends a finished turn), Add to Waiting on you, Rewind to here or Edit from here,
 * and on replies Fork from here and Fork into worktree…. `floating`: over the message where there
 * is room and a hovering pointer (`FLOATING`), the reply's at its end, the user's beside its
 * bubble.
 */
export function MessageActions({
  threadId,
  message,
  turnEnd = false,
  floating = false,
}: {
  threadId: ThreadId;
  message: GramUIMessage;
  turnEnd?: boolean;
  floating?: boolean;
}) {
  // Another thread's message sits on the agents' side, so its actions do too.
  const isUser =
    message.role === "user" && !message.parts.some((part) => part.type === "data-thread-origin");
  const readOnly = useReadOnlyTranscript();
  const place = cn(
    IN_FLOW,
    isUser ? "justify-end" : "justify-start",
    floating && FLOATING,
    floating && (isUser ? FLOAT_USER : FLOAT_REPLY),
  );
  return (
    <div data-testid="message-actions" data-floating={floating || undefined} className={place}>
      {/* On the side towards the conversation, so the buttons keep their place at the edge. */}
      {isUser && <SentAt message={message} />}
      <CopyAction
        testId="message-copy"
        label="Copy message"
        text={() => messageMarkdown(message)}
      />
      {!readOnly && <MessageMenu threadId={threadId} message={message} turnEnd={turnEnd} />}
      {!isUser && <SentAt message={message} />}
      {!isUser && <ReplyTokens message={message} />}
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
      className="px-1.5 py-0.5 text-meta text-muted-foreground tabular-nums"
    >
      {formatMessageStamp(createdAt)}
    </time>
  );
}

/** A menu item's glyph, its name, and a line under it: what it does, or why it can't now. */
function ItemText({ icon, label, line }: { icon: ReactNode; label: string; line: string }) {
  return (
    <>
      {icon}
      <span>
        <span className="block">{label}</span>
        <span className="block text-meta text-muted-foreground">{line}</span>
      </span>
    </>
  );
}

/**
 * The "…" beside Copy, and what its items open: the rewind or edit confirmation, anchored to the
 * "…" and handing focus back to it, and the worktree fork's dialog.
 */
function MessageMenu({
  threadId,
  message,
  turnEnd,
}: {
  threadId: ThreadId;
  message: GramUIMessage;
  turnEnd: boolean;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  // Rewind or Edit was chosen: its confirmation opens once the menu has closed and handed focus
  // back to the "…", so that hand-back can't pull focus out of the confirmation.
  const confirmNext = useRef(false);
  const [dialog, setDialog] = useState<{ notice?: string }>();
  const wait = useWait(threadId, message);
  const rewind = useRewind(threadId, message);
  const fork = useForkFromHere(threadId, message, setDialog);
  const reply = message.role === "assistant";
  return (
    <>
      <Menu.Root
        onOpenChangeComplete={(open) => {
          if (open || !confirmNext.current) return;
          confirmNext.current = false;
          setConfirming(true);
        }}
      >
        <Hint
          label="More message actions"
          render={
            <Menu.Trigger
              ref={more}
              render={<Button variant="ghost" size="icon-sm" />}
              data-testid="message-more"
              aria-label="More message actions"
              className={ACTION}
            />
          }
        >
          <Ellipsis aria-hidden className="size-icon-row" />
        </Hint>
        <Menu.Portal>
          <Menu.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
            <Menu.Popup className="min-w-56 max-w-[calc(100vw-1rem)] rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none">
              {turnEnd && <TurnCopyAction threadId={threadId} message={message} />}
              <Menu.Item
                data-testid="message-wait"
                aria-label={wait.label}
                aria-description={wait.line}
                disabled={wait.disabled}
                onClick={() => void wait.add()}
                className={MENU_ITEM}
              >
                <ItemText
                  icon={
                    <Inbox
                      aria-hidden
                      className={cn("size-icon-row", wait.kept && "text-status-needs-mark")}
                    />
                  }
                  label={wait.label}
                  line={wait.line}
                />
              </Menu.Item>
              {rewind !== undefined && (
                <Menu.Item
                  data-testid={rewind.isUser ? "message-edit" : "message-rewind"}
                  aria-label={rewind.label}
                  aria-description={rewind.line}
                  disabled={rewind.disabledReason !== undefined}
                  onClick={() => {
                    confirmNext.current = true;
                  }}
                  className={MENU_ITEM}
                >
                  <ItemText
                    icon={<rewind.Icon aria-hidden className="size-icon-row" />}
                    label={rewind.label}
                    line={rewind.line}
                  />
                </Menu.Item>
              )}
              {reply && (
                <>
                  <Menu.Item
                    data-testid="message-fork"
                    aria-label="Fork from here"
                    aria-description={fork.forkLine}
                    disabled={fork.forkReason !== undefined}
                    onClick={() => void fork.forkHere()}
                    className={MENU_ITEM}
                  >
                    <ItemText
                      icon={<GitFork aria-hidden className="size-icon-row" />}
                      label="Fork from here"
                      line={fork.forkLine}
                    />
                  </Menu.Item>
                  <Menu.Item
                    data-testid="message-fork-worktree"
                    aria-label="Fork into worktree…"
                    aria-description={fork.worktreeLine}
                    disabled={fork.worktreeReason !== undefined}
                    onClick={() => setDialog({})}
                    className={MENU_ITEM}
                  >
                    <ItemText
                      icon={<FolderGit2 aria-hidden className="size-icon-row" />}
                      label="Fork into worktree…"
                      line={fork.worktreeLine}
                    />
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {rewind !== undefined && (
        <RewindConfirm
          rewind={rewind}
          anchor={more}
          open={confirming}
          onOpenChange={setConfirming}
        />
      )}
      {fork.error && (
        <p role="alert" className="text-meta text-destructive">
          {fork.error}
        </p>
      )}
      {dialog && (
        <ForkDialog
          threadId={threadId}
          fromMessageId={message.id as MessageId}
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

/**
 * "Add to Waiting on you": keeps the message in the thread's tray, as a draft whose Copy takes its
 * quoted or fenced block, titled by its first line. Shown done while an open item already points
 * at it.
 */
function useWait(threadId: ThreadId, message: GramUIMessage) {
  const api = useApi();
  const kept = useThreadsStore(
    (s) => s.byId[threadId]?.waits?.some((item) => item.messageId === message.id) === true,
  );
  const [pending, setPending] = useState(false);
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
  return {
    kept,
    label: kept ? "Waiting on you" : "Add to Waiting on you",
    line: disabledReason ?? "Keep it in this thread's tray to come back to",
    disabled: disabledReason !== undefined,
    add,
  };
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
          <DrawnCheck className="size-icon-row text-success" />
        ) : (
          <Copy aria-hidden className="size-icon-row" />
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
          <span className="block text-meta text-muted-foreground">
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

type Rewind = NonNullable<ReturnType<typeof useRewind>>;

/**
 * "Rewind to here" (assistant) or "Edit from here" (user), confirmed in a popover with an optional
 * "Restore files too". Undefined when the agent can't rewind; disabled while a turn runs.
 */
function useRewind(threadId: ThreadId, message: GramUIMessage) {
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const rewindSupport = useThreadsStore((s) => s.byId[threadId]?.capabilities?.rewind);
  // Capabilities reach the store with the next snapshot, not with `thread.upsert`, so a thread created
  // this session has none yet. Offer history only until we know files can be restored too.
  const support = rewindSupport ?? "history";
  if (support === "none") return undefined;
  const isUser = message.role === "user";
  const busy = status !== undefined && BUSY.has(status);
  // User targets resume from the reply before them, which the server resolves.
  const disabledReason = busy
    ? "Wait for the turn to finish"
    : isUser || hasAgentIds(message)
      ? undefined
      : "This reply can't be rewound to yet";
  return {
    threadId,
    message,
    isUser,
    busy,
    support,
    disabledReason,
    label: isUser ? "Edit from here" : "Rewind to here",
    line:
      disabledReason ??
      (isUser
        ? "Edit this message and replace the conversation after it"
        : "Remove the conversation after this reply"),
    Icon: isUser ? Pencil : History,
  };
}

/** The rewind or edit's confirmation, under the "…" it was chosen from, which focus returns to. */
function RewindConfirm({
  rewind,
  anchor,
  open,
  onOpenChange,
}: {
  rewind: Rewind;
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const cancel = useRef<HTMLButtonElement>(null);
  const [files, setFiles] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const { threadId, message, isUser, support, busy } = rewind;
  const restoreFiles = support === "historyAndFiles" && files;
  const messageId = message.id as MessageId;

  const confirm = async () => {
    if (isUser) {
      useDraftStore.getState().startEdit(threadId, messageText(message), {
        messageId,
        files: restoreFiles,
      });
      onOpenChange(false);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await api.rewind(threadId, messageId, restoreFiles);
      onOpenChange(false);
    } catch (e) {
      setError(rewindFailure(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(undefined);
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align={isUser ? "end" : "start"}
          sideOffset={4}
        >
          <Popover.Popup
            data-testid="rewind-confirm"
            // Into the confirmation, on its safe choice, however it was opened.
            initialFocus={cancel}
            finalFocus={anchor}
            className="z-50 flex w-64 flex-col gap-2 rounded-(--radius-lg) border border-edge bg-popover p-3 text-reading text-popover-foreground shadow-(--shadow-raised) transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Popover.Title className="font-medium">
              {isUser ? "Edit this message?" : "Rewind to this reply?"}
            </Popover.Title>
            <Popover.Description className="text-meta text-muted-foreground">
              {isUser
                ? "The composer is filled with it; sending removes it and everything after."
                : "Everything after this reply is removed from the conversation."}
            </Popover.Description>
            {support === "historyAndFiles" && (
              <label className="flex items-center gap-2 text-meta">
                <input
                  type="checkbox"
                  checked={files}
                  onChange={(event) => setFiles(event.target.checked)}
                />
                Restore files too
              </label>
            )}
            {error && (
              <p role="alert" className="text-meta text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Popover.Close
                ref={cancel}
                className="rounded-(--radius-sm) px-2 py-1 text-meta text-muted-foreground hover:text-foreground"
              >
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
 * "Fork from here" and "Fork into worktree…" on a reply, each with why it can't while forking isn't
 * possible. A refused fork into the source checkout continues in the worktree dialog (`openDialog`).
 */
function useForkFromHere(
  threadId: ThreadId,
  message: GramUIMessage,
  openDialog: (dialog: { notice?: string }) => void,
) {
  const { available, reason } = useForkAvailability(threadId);
  const { fork, pending, error } = useForkThread(threadId);
  const disabledReason =
    reason ?? (hasAgentIds(message) ? undefined : "This reply can't be forked from yet");
  const forkHere = async () => {
    const result = await fork({ fromMessageId: message.id as MessageId });
    if (result === "needsWorktree") openDialog({ notice: WORKTREE_NOTICE });
  };
  const blocked = available ? disabledReason : (disabledReason ?? "Forking isn't available");
  const forkReason = blocked ?? (pending ? "Forking thread…" : undefined);
  return {
    forkHere,
    error,
    forkReason,
    forkLine: forkReason ?? "Start a new thread with the conversation up to this reply",
    worktreeReason: blocked,
    worktreeLine: blocked ?? "Continue from this reply in a new worktree",
  };
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
