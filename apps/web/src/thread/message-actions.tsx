import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { MessageId, type GramUIMessage, type ThreadId, type ThreadStatus } from "@gram/contracts";
import {
  Copy,
  Ellipsis,
  FolderGit2,
  GitFork,
  History,
  Inbox,
  MessagesSquare,
  Pencil,
  Send,
  SquareArrowRight,
} from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";

import { useApi } from "@/api/context";
import { errorMessage, rewindErrorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatMessageStamp, formatMessageTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DrawnCheck, Swap } from "@/motion";
import { useDraftStore } from "@/stores/drafts";
import { feedMessages } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";
import { useFlash } from "@/lib/timers";

import { COPIED_MS, copyMarkdown } from "./copy-command";
import { messageMarkdown, turnMarkdown, turnMessages } from "./copy-markdown";
import { ForkDialog } from "./fork-dialog";
import { ReplyTokens } from "./reply-tokens";
import { useForkAvailability, useForkThread, WORKTREE_NOTICE } from "./use-fork";
import { useReadOnlyTranscript } from "./read-only-transcript";

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

const hasAgentIds = (message: GramUIMessage) =>
  (message.metadata?.agentMessageIds?.length ?? 0) > 0;

const IN_FLOW =
  "-mt-1 flex flex-wrap items-center gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-within:opacity-100 has-data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100";

const FLOATING =
  "float-actions:absolute float-actions:z-10 float-actions:mt-0 float-actions:flex-nowrap float-actions:whitespace-nowrap float-actions:rounded-(--radius-sm) float-actions:border float-actions:border-edge float-actions:bg-popover float-actions:p-0.5 float-actions:shadow-overlay";

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

const DELIVERY = {
  steer: {
    icon: Send,
    label: "Steered",
    hint: "Steered into the running turn, after its tool calls finished. Nothing was cancelled.",
  },
  interrupt: {
    icon: SquareArrowRight,
    label: "Interrupted the turn",
    hint: "Stopped the running turn and was answered at once. Tool calls it cut off show as interrupted.",
  },
} as const;

/**
 * "Steered" or "Interrupted the turn" under a message that went into a running turn, always shown
 * (not with the actions on hover), as "Gram told the agent" is; nothing on any other message.
 */
export function DeliveryLine({ message }: { message: GramUIMessage }) {
  const delivery = message.metadata?.delivery;
  if (delivery === undefined) return null;
  const { icon: Icon, label, hint } = DELIVERY[delivery];
  return (
    <span
      data-testid="message-delivery"
      data-delivery={delivery}
      title={hint}
      className="flex items-center justify-end gap-1 text-meta text-muted-foreground"
    >
      <Icon aria-hidden className="size-icon-chip" />
      {label}
    </span>
  );
}

/**
 * "From Slack · #runbooks" under a message an embedding host sent from one of its conversations,
 * always shown, as the delivery line is; nothing on any other message.
 */
export function ConversationLine({ message }: { message: GramUIMessage }) {
  const part = message.parts.find((p) => p.type === "data-conversation");
  if (part === undefined) return null;
  const { id, label } = part.data;
  return (
    <span
      data-testid="message-conversation"
      title={id}
      className="flex items-center justify-end gap-1 text-meta text-muted-foreground"
    >
      <MessagesSquare aria-hidden className="size-icon-chip" />
      From {label ?? "a conversation outside Gram"}
    </span>
  );
}

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
          fromMessageId={MessageId.make(message.id)}
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

function useWait(threadId: ThreadId, message: GramUIMessage) {
  const api = useApi();
  const kept = useThreadsStore(
    (s) => s.byId[threadId]?.waits?.some((item) => item.messageId === message.id) === true,
  );
  const [pending, setPending] = useState(false);
  const add = async () => {
    setPending(true);
    try {
      await api.addWait(threadId, MessageId.make(message.id));
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
  const [copied = false, flash] = useFlash(COPIED_MS);
  const shown = copied ? "Copied" : label;
  const copy = () => void copyMarkdown(text()).then((ok) => ok && flash(true));
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

const rewindFailure = (error: unknown) =>
  errorMessage(error).includes("no checkpoint")
    ? "Files can't be restored to this message. Rewind without “Restore files too”."
    : rewindErrorMessage(error);

type Rewind = NonNullable<ReturnType<typeof useRewind>>;

function useRewind(threadId: ThreadId, message: GramUIMessage) {
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const rewindSupport = useThreadsStore((s) => s.byId[threadId]?.capabilities?.rewind);
  const support = rewindSupport ?? "history";
  if (support === "none") return undefined;
  const isUser = message.role === "user";
  const busy = status !== undefined && BUSY.has(status);
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

  const confirm = async () => {
    const messageId = MessageId.make(message.id);
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
    const result = await fork({ fromMessageId: MessageId.make(message.id) });
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
