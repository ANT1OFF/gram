import {
  effectiveCheckout,
  type SubagentUsageData,
  type GramUIMessage,
  type ThreadId,
  type TurnId,
} from "@gram/contracts";
import { FileText, Paperclip } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  Message,
  MessageContent,
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message";
import { useOrchestratorStreamContext } from "@/orchestration/stream-context";
import { checkoutRelative } from "@/panels/files/files-store";
import { formatMessageTime } from "@/lib/time";
import { imageDataUrl, useAttachmentImage } from "@/panels/files/image-preview";
import { copyText } from "@/settings/copy-text";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useTurnFolds } from "@/stores/turn-folds";

import { AgentErrorCard } from "./agent-error-card";
import { BabysitReportCard } from "./babysit-report-card";
import { CompactionMarker, IdleCompactRequest } from "./compaction-marker";
import { SessionRestartMarker } from "./session-restart-marker";
import { AttachmentLightbox } from "./attachment-lightbox";
import { MockCard } from "./mock-visuals";
import { MessageActions, messageText } from "./message-actions";
import { FILE_REF_COMPONENTS } from "./file-ref-link";
import { rehypeFileRefs } from "./file-refs";
import { PR_REF_COMPONENTS } from "./pr-ref-link";
import { rehypePrRefs } from "./pr-refs";
import { ReasoningBlock } from "./reasoning-block";
import { ThreadMessage } from "./message-origin";
import { THREAD_REF_COMPONENTS, ThreadLinkedText } from "./thread-ref-link";
import { rehypeWorkerNames, WORKER_REF_COMPONENTS } from "./worker-names";
import { rehypeThreadRefs } from "./thread-refs";
import {
  DreamReportCard,
  HandoffDivider,
  MemoryWriteCard,
  WorkerAnswerCard,
  WorkerQuestionCard,
  OrchestrationDigestCard,
  WorkerReportCard,
} from "./orchestration-cards";
import { isToolPart } from "./parts";
import { HumanReviewNoticeCard, ReviewNoticeCard } from "./review-notice-card";
import { TaskChip } from "./task-chip";
import { WaitChip, WaitNoteLine } from "./waiting-tray";
import { ArtifactCard } from "./artifact-card";
import { PreviewFileCard } from "./preview-file-card";
import { previewableFiles } from "./preview-files";
import { publishedArtifacts } from "./published-artifacts";
import { ToolCard } from "./tool-cards";
import { ToolGroup, TurnFoldRow } from "./tool-group";
import { toolImagesOf, toolRuns, type MessageFold } from "./tool-group-model";
import { ToolImagesContext } from "./tool-images";
import { TurnFilesChip } from "./turn-files-chip";
import { WidgetCard } from "./widget-card";

/**
 * A `file://` part URL as the path it names. A Windows URL is `file:///C:/…`, whose path is `C:/…`:
 * keeping the slash names a file that doesn't exist, so the server refused every preview there.
 */
export const filePath = (url: string) => {
  if (!url.startsWith("file://")) return url;
  const path = decodeURIComponent(url.slice("file://".length));
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
};

type RehypePlugins = Extract<MessageResponseProps["rehypePlugins"], (...args: never) => unknown>;

/**
 * Streamdown's plugins with thread links and file references marked before `harden`, which turns a
 * relative link such as `[a.ts](src/a.ts#L3)` into "[blocked]", and PR references after it.
 */
const refRehypePlugins: RehypePlugins = (defaults) => [
  defaults["raw"]!,
  defaults["sanitize"]!,
  rehypeThreadRefs,
  rehypeFileRefs,
  defaults["harden"]!,
  rehypePrRefs,
];
const REF_COMPONENTS = {
  ...PR_REF_COMPONENTS,
  ...FILE_REF_COMPONENTS,
  ...THREAD_REF_COMPONENTS,
  ...WORKER_REF_COMPONENTS,
};

/** The plugins of an orchestrator's messages: its workers' names become links too. */
function useRefPlugins(): RehypePlugins {
  const workers = useOrchestratorStreamContext()?.workers;
  return useMemo(
    () =>
      workers === undefined || workers.length === 0
        ? refRehypePlugins
        : (defaults) => [...refRehypePlugins(defaults), rehypeWorkerNames(workers)],
    [workers],
  );
}

/** The extensions the server previews; `.heic` and `.bmp` attach fine but stay chips. */
const PREVIEWABLE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/**
 * An attached file: a thumbnail that opens full size when the server can preview it, and the
 * paperclip chip otherwise — a text file, an image format with no preview, one too large to send
 * inline, and one whose file has since been deleted all keep the chip.
 */
function MessageAttachment({
  threadId,
  url,
  filename,
}: {
  threadId: ThreadId;
  url: string;
  filename: string | undefined;
}) {
  const path = filePath(url);
  const name = filename ?? path;
  const query = useAttachmentImage(threadId, path, PREVIEWABLE.test(path));
  const src = imageDataUrl(query.data);
  return (
    <li data-testid="message-attachment" title={path} className="max-w-full">
      {src === undefined ? (
        <span className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs">
          <Paperclip aria-hidden className="size-3" />
          {name}
        </span>
      ) : (
        <AttachmentLightbox src={src} name={name} />
      )}
    </li>
  );
}

/**
 * A file the agent sent with `send_file`: the same inline preview as an attachment when it's an
 * image the server can serve, and otherwise a card that opens the file in the Files panel, or
 * copies its path when the file is outside the thread's checkout.
 */
function SentFile({ threadId, url }: { threadId: ThreadId; url: string }) {
  const path = filePath(url);
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const query = useAttachmentImage(threadId, path, PREVIEWABLE.test(path));
  const src = imageDataUrl(query.data);
  const requestPanel = useLayoutStore((s) => s.requestPanel);
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const root = thread === undefined ? undefined : effectiveCheckout(thread).path;
  // `send_file` takes a file from anywhere, a temp folder as readily as the checkout, but the Files
  // panel only opens what is inside the checkout. A button it would silently refuse is worse than
  // none, so a file out there gets its path to copy instead.
  const inCheckout = checkoutRelative(path, root) !== undefined;
  const [copied, setCopied] = useState(false);
  const card =
    "flex max-w-full items-center gap-2 self-start rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  return (
    <div data-testid="sent-file" title={path} className="my-1 flex max-w-full flex-col gap-1">
      {src !== undefined ? (
        <>
          <AttachmentLightbox src={src} name={name} />
          <span className="truncate text-xs text-muted-foreground">{name}</span>
        </>
      ) : inCheckout ? (
        <button
          type="button"
          aria-label={`Open ${name} in Files`}
          className={card}
          // The click comes from this thread's own pane, so this is the thread being viewed.
          onClick={() => requestPanel({ threadId, panel: "files", target: path }, threadId)}
        >
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Copy the path of ${name}`}
          className={card}
          onClick={() => {
            copyText(path).then(
              () => setCopied(true),
              (error: unknown) => console.error("sent file: copy path", error),
            );
          }}
        >
          <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{name}</span>
            <span
              key={copied ? "copied" : "path"}
              className={`truncate text-xs text-muted-foreground${copied ? " gram-fade" : ""}`}
            >
              {copied ? "Path copied" : path}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

export interface MessageBlockProps {
  threadId: ThreadId;
  message: GramUIMessage;
  streamingIds: ReadonlySet<string>;
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  /** The latest counts for each subagent run, keyed by its tool call id. */
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
  /** Animates streaming text; background panes still render chunks, just without animation. */
  animate?: boolean;
  /** Set on a finished turn's last reply: the turn whose changed files it offers. */
  turnEnd?: TurnId | undefined;
  /** How this reply's turn folds, when it does. */
  fold?: MessageFold | undefined;
  /** The reader opened that fold. */
  foldOpen?: boolean | undefined;
}

export const MessageBlock = memo(function MessageBlock({
  threadId,
  message,
  streamingIds,
  subagents,
  subagentUsage,
  animate = false,
  turnEnd,
  fold,
  foldOpen = false,
}: MessageBlockProps) {
  // Subagent transcripts nest under a Task card and aren't rewind points.
  const topLevel = message.metadata?.parentToolUseId === undefined;
  const refPlugins = useRefPlugins();
  const toolImages = useMemo(
    () => ({ threadId, byCall: toolImagesOf(message.parts) }),
    [threadId, message.parts],
  );
  // The action row shows when a message arrived; a message without one (a subagent's, or a reply
  // still streaming) has it as a native hint instead. Native rather than a tooltip: it costs nothing
  // per message, leaves selection alone, and a hint of the message's own (a path) replaces it.
  const createdAt = message.metadata?.createdAt;
  const sentAt = createdAt === undefined ? undefined : formatMessageTime(createdAt);

  if (message.role === "user") {
    const notice = message.parts.find((p) => p.type === "data-review-notice");
    const humanReview = message.parts.find((p) => p.type === "data-human-review-notice");
    const digest = message.parts.find((p) => p.type === "data-orchestration-digest");
    const idleCompact = message.parts.find((p) => p.type === "data-idle-compact");
    if (idleCompact) return <IdleCompactRequest notice={idleCompact.data} />;
    const origin = message.parts.find((p) => p.type === "data-thread-origin");
    const waitNote = message.parts.find((p) => p.type === "data-wait-note");
    const waitChips = message.parts.flatMap((p) => (p.type === "data-wait" ? [p] : []));
    const files = message.parts.flatMap((part) => (part.type === "file" ? [part] : []));
    const attached = files.length > 0 && (
      <ul aria-label="Attached files" className="mt-1 flex flex-wrap gap-1 whitespace-normal">
        {files.map((file, i) => (
          <MessageAttachment
            key={`${file.url}:${i}`}
            threadId={threadId}
            url={file.url}
            filename={file.filename}
          />
        ))}
      </ul>
    );
    // Another thread's message isn't the user's: it sits on the agents' side, under its sender.
    if (origin && !notice && !humanReview && !digest) {
      return (
        <Message from="assistant" data-testid="message-from-thread">
          <div
            data-testid="message-time"
            title={topLevel ? undefined : sentAt}
            className="contents"
          >
            <ThreadMessage origin={origin.data}>
              <ThreadLinkedText text={messageText(message)} />
              {attached}
            </ThreadMessage>
          </div>
          {waitChips.map((part) => (
            <WaitChip key={part.id} wait={part.data} />
          ))}
          {waitNote && <WaitNoteLine note={waitNote.data} />}
          {topLevel && <MessageActions threadId={threadId} message={message} />}
        </Message>
      );
    }
    return (
      <Message from="user" data-testid="message-user">
        {/* Around the bubble or card alone, not the row's width beside it or the actions. */}
        <div data-testid="message-time" title={topLevel ? undefined : sentAt} className="contents">
          {notice ? (
            <ReviewNoticeCard notice={notice.data} text={messageText(message)} />
          ) : humanReview ? (
            <HumanReviewNoticeCard notice={humanReview.data} text={messageText(message)} />
          ) : digest ? (
            <OrchestrationDigestCard
              digest={digest.data}
              text={messageText(message)}
              createdAt={message.metadata?.createdAt}
            />
          ) : (
            <MessageContent className="whitespace-pre-wrap">
              {messageText(message)}
              {attached}
            </MessageContent>
          )}
        </div>
        {waitChips.map((part) => (
          <WaitChip key={part.id} wait={part.data} />
        ))}
        {waitNote && <WaitNoteLine note={waitNote.data} />}
        {topLevel && <MessageActions threadId={threadId} message={message} />}
      </Message>
    );
  }

  const streaming = streamingIds.has(message.id);
  const folded = fold !== undefined && !foldOpen;
  const actions = topLevel && !streaming && !(folded && fold.empty);
  const renderSubagent = (child: GramUIMessage) => (
    <MessageBlock
      threadId={threadId}
      message={child}
      streamingIds={streamingIds}
      subagents={subagents}
      subagentUsage={subagentUsage}
      animate={animate}
    />
  );

  const runs = toolRuns(message.parts, folded ? fold.apart : undefined);
  // Summary and raw parts share one visual; each retains its own text and open lifecycle.
  const reasoningIndex = message.parts.findLastIndex((part) => part.type === "reasoning");
  const reasoningOpen =
    streaming &&
    message.parts.some((part) => part.type === "reasoning" && part.state === "streaming");
  return (
    <Message
      from="assistant"
      data-testid="message-assistant"
      data-streaming={streaming ? "true" : undefined}
      className="max-w-full"
    >
      {fold?.row && (
        <TurnFoldRow
          turn={fold.row}
          open={foldOpen}
          onToggle={() => useTurnFolds.getState().toggle(threadId, fold.turn)}
        />
      )}
      <MessageContent
        data-testid="message-time"
        title={actions ? undefined : sentAt}
        className="w-full"
      >
        <ToolImagesContext value={toolImages}>
          {message.parts.map((part, i) => {
            const key = `${message.id}:${i}`;
            if (runs.absorbed.has(i) || fold?.under.has(i)) return null;
            if (folded && fold.hidden.has(i)) return null;
            const run = runs.starts.get(i);
            if (run) {
              return (
                <ToolGroup
                  key={key}
                  run={run}
                  subagents={subagents}
                  subagentUsage={subagentUsage}
                  streamingIds={streamingIds}
                  renderSubagent={renderSubagent}
                />
              );
            }
            if (isToolPart(part)) {
              return (
                <ToolCard
                  key={key}
                  part={part}
                  subagents={subagents}
                  subagentUsage={subagentUsage}
                  streamingIds={streamingIds}
                  renderSubagent={renderSubagent}
                />
              );
            }
            switch (part.type) {
              case "text":
                return (
                  <MessageResponse
                    key={key}
                    isAnimating={animate && streaming}
                    components={REF_COMPONENTS}
                    rehypePlugins={refPlugins}
                  >
                    {part.text}
                  </MessageResponse>
                );
              case "reasoning":
                return i === reasoningIndex ? (
                  <ReasoningBlock key={key} isStreaming={reasoningOpen} />
                ) : null;
              case "file":
                return <SentFile key={key} threadId={threadId} url={part.url} />;
              case "data-chapter":
                return (
                  <div
                    key={key}
                    id={`chapter-${part.data.id}`}
                    data-testid="chapter"
                    className="my-3 flex items-center gap-3 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    <span className="h-px flex-1 bg-border" />
                    {part.data.title}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                );
              case "data-compaction":
                return <CompactionMarker key={key} compaction={part.data} />;
              case "data-session-restart":
                return <SessionRestartMarker key={key} restart={part.data} />;
              case "data-agent-error":
                return <AgentErrorCard key={key} threadId={threadId} error={part.data} />;
              case "data-task-chip":
                return <TaskChip key={key} threadId={threadId} chip={part.data} />;
              case "data-wait":
                return <WaitChip key={key} wait={part.data} />;
              case "data-widget":
                return <WidgetCard key={key} widget={part.data} />;
              case "data-babysit-report":
                return <BabysitReportCard key={key} report={part.data} />;
              case "data-worker-report":
                return <WorkerReportCard key={key} report={part.data} />;
              case "data-memory-write":
                return <MemoryWriteCard key={key} write={part.data} />;
              case "data-handoff":
                return <HandoffDivider key={key} handoff={part.data} />;
              case "data-worker-answer":
                return <WorkerAnswerCard key={key} answer={part.data} threadId={threadId} />;
              case "data-worker-question":
                return <WorkerQuestionCard key={key} question={part.data} threadId={threadId} />;
              case "data-mock":
                return <MockCard key={key} threadId={threadId} mock={part.data} />;
              case "data-dream-report":
                return <DreamReportCard key={key} report={part.data} threadId={threadId} />;
              default:
                return null;
            }
          })}
        </ToolImagesContext>
        <PublishedFileCards threadId={threadId} parts={message.parts} />
      </MessageContent>
      {actions && turnEnd !== undefined && <TurnFilesChip threadId={threadId} turnId={turnEnd} />}
      {actions && (
        <MessageActions threadId={threadId} message={message} turnEnd={turnEnd !== undefined} />
      )}
      {fold !== undefined &&
        [...fold.under].map((i) => {
          const part = message.parts[i];
          return part?.type === "data-task-chip" ? (
            <TaskChip key={part.data.id} threadId={threadId} chip={part.data} />
          ) : null;
        })}
    </Message>
  );
});

/**
 * The cards under a message for what it left to look at: each page it published to claude.ai, and
 * each Markdown or HTML file it wrote that isn't one of those pages' sources, which their cards
 * already show.
 */
function PublishedFileCards({
  threadId,
  parts,
}: {
  threadId: ThreadId;
  parts: readonly unknown[];
}) {
  const artifacts = publishedArtifacts(parts);
  const sources = new Set(artifacts.flatMap((artifact) => artifact.source?.path ?? []));
  return (
    <>
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.url} threadId={threadId} artifact={artifact} />
      ))}
      {previewableFiles(parts)
        .filter((file) => !sources.has(file.path))
        .map((file) => (
          <PreviewFileCard key={file.path} threadId={threadId} file={file} />
        ))}
    </>
  );
}
