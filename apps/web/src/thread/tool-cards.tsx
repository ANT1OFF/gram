import {
  FILE_EDIT_TOOLS,
  splitToolImageOutput,
  type SubagentUsageData,
  type GramUIMessage,
} from "@gram/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Tool } from "@/components/ai-elements/tool";
import { HighlightedCode } from "@/components/ai-elements/code-block";
import { JsonText } from "./json-text";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Expand, isMarkPhase, StatusMark, Swap } from "@/motion";
import { useOrchestratorStreamContext } from "@/orchestration/stream-context";

import { ApprovalSlot, ApprovalSlotsOpen } from "./approval-slots";
import { useAwaitingTools, withApproval } from "./awaiting-tools";
import {
  basename,
  PHASE_DISPLAY,
  toolNameOf,
  toolPhase,
  type AnyToolPart,
  type ToolPartOf,
  type ToolPhase,
} from "./parts";
import { isGramTool, toolLabel, type ToolLabel } from "./tool-labels";
import { FileEditCard } from "./file-edit-card";
import { ToolImages } from "./tool-images";
import { toolDetail } from "./tool-group-model";

export interface ToolCardProps {
  part: AnyToolPart;
  /** Subagent transcripts keyed by tool call id. */
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  /** The latest counts for each subagent run, keyed by its tool call id. */
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
  /** Messages still streaming, so a background subagent's card can show it is running. */
  streamingIds: ReadonlySet<string>;
  renderSubagent: (message: GramUIMessage) => ReactNode;
}

/**
 * A tool call's row, with its approval card right under it while the call waits on one. The two
 * are one block, 8 px apart: the reply's wider gap between its blocks (message-block.tsx) would
 * set the card off from the row it decides.
 */
export function ToolCard(props: ToolCardProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ToolCardRow {...props} />
      <ApprovalSlot toolCallId={props.part.toolCallId} />
    </div>
  );
}

function ToolCardRow({
  part,
  subagents,
  subagentUsage,
  streamingIds,
  renderSubagent,
}: ToolCardProps) {
  // Claude's and Codex's file changes alike, by tool name: Codex's calls are dynamic parts.
  if (FILE_EDIT_TOOLS.has(toolNameOf(part))) return <FileEditCard part={part} />;
  // Native web parts retain their opaque provider results in GenericCard.
  if (part.type === "tool-WebSearch") return <WebSearchCard part={part} />;
  if (part.type === "tool-WebFetch") return <WebFetchCard part={part} />;
  switch (part.type) {
    case "tool-Bash":
      return <BashCard part={part} />;
    case "tool-Read":
      return <ReadCard part={part} />;
    case "tool-Glob":
    case "tool-Grep":
      return <SearchCard part={part} />;
    case "tool-Task":
    case "tool-Agent":
      return (
        <TaskCard
          part={part}
          messages={subagents.get(part.toolCallId) ?? []}
          usage={subagentUsage.get(part.toolCallId)}
          streamingIds={streamingIds}
          renderSubagent={renderSubagent}
        />
      );
    default:
      return (
        <GenericCard part={part}>
          {(subagents.get(part.toolCallId)?.length ?? 0) > 0 && (
            <div
              className="space-y-1 border-l-2 border-border pl-3"
              data-testid="subagent-transcript"
            >
              {subagents.get(part.toolCallId)!.map((message) => (
                <div key={message.id}>{renderSubagent(message)}</div>
              ))}
            </div>
          )}
        </GenericCard>
      );
  }
}

function ToolShell({
  part,
  name,
  summary,
  meta,
  phase: phaseOverride,
  label: labelOf,
  defaultOpen = false,
  children,
}: {
  part: AnyToolPart;
  /** The tool's name, as the row's `data-tool` keeps it; also its words unless `label` gives some. */
  name: string;
  /** The row's words for the call in a phase, with the raw tool id its details show instead. */
  label?: (phase: ToolPhase) => ToolLabel;
  summary?: ReactNode;
  meta?: ReactNode;
  /** Overrides what `part.state` implies, e.g. for a background subagent that is still running. */
  phase?: ReturnType<typeof toolPhase>;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const awaiting = useAwaitingTools();
  const phase = withApproval(
    phaseOverride ??
      toolPhase(
        part.state,
        part.state === "output-error" ? part.errorText : undefined,
        part.state === "output-available" && part.preliminary === true,
      ),
    part.toolCallId,
    awaiting,
  );
  const display = PHASE_DISPLAY[phase];
  const words = labelOf?.(phase) ?? { label: name, raw: undefined };
  // In the orchestrator's chat, one of Gram's own calls that went through ("Started a worker",
  // "Queued to merge when ready") is an event, not work to inspect: a line of muted meta like an
  // update's, its chevron first, so the reply around it stays the strongest thing in the pane. A
  // call still running, waiting on you or failed keeps its card.
  const quiet =
    useOrchestratorStreamContext() !== undefined &&
    phase === "done" &&
    isGramTool(toolNameOf(part));
  const [open, setOpen] = useState(defaultOpen);
  // A closed body is inert and zero-height, so it isn't rendered until first opened: a long
  // transcript would otherwise lay out every tool's full output. It stays mounted once opened, so
  // closing still animates.
  const [opened, setOpened] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <Tool
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setOpened(true);
      }}
      className={
        quiet
          ? "group/tool mb-0 rounded-none border-0 bg-transparent"
          : "group/tool mb-0 rounded-(--radius-md) border-edge-action bg-card/40"
      }
      data-testid="tool-card"
      data-tool={name}
      data-tool-call-id={part.toolCallId}
      data-quiet={quiet ? "true" : undefined}
    >
      {quiet ? (
        <CollapsibleTrigger
          aria-controls={bodyId}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className="size-icon-chip shrink-0 transition-transform duration-(--dur-fast) in-data-panel-open:rotate-90"
          />
          <span className="shrink-0">{words.label}</span>
          {summary !== undefined && summary !== null && summary !== "" && (
            <span className="min-w-0 flex-1 truncate">· {summary}</span>
          )}
          {meta}
          <span className="sr-only">{display.label}</span>
        </CollapsibleTrigger>
      ) : (
        <div className="flex items-center">
          <CollapsibleTrigger
            aria-controls={bodyId}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-reading"
          >
            {/* The mark stays mounted from pending to done, so its arc can close into the check. */}
            {/* A native title: a tooltip trigger inside the row's toggle would take its click. */}
            <span title={display.label} className="flex shrink-0">
              <Swap swapKey={isMarkPhase(phase) ? "mark" : phase}>
                {isMarkPhase(phase) ? (
                  <StatusMark phase={phase} className={cn("size-icon-row", display.tone)} />
                ) : (
                  <display.icon aria-hidden className={cn("size-icon-row", display.tone)} />
                )}
              </Swap>
            </span>
            <span className="shrink-0 font-medium">{words.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">
              {summary}
            </span>
            {meta}
            {/* A finished row is the common case: its check says so, and the word is for a reader.
            A waiting row's card is right under it. */}
            <span className={cn("shrink-0 text-meta", phase === "done" ? "sr-only" : display.tone)}>
              {display.label}
            </span>
            <ChevronDown
              aria-hidden
              className="size-icon-chip shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) in-data-panel-open:rotate-180"
            />
          </CollapsibleTrigger>
        </div>
      )}
      {!open && (
        <ToolImages
          part={part}
          size="thumbnail"
          className="flex flex-wrap items-end gap-2 px-3 pb-2"
        />
      )}
      <Expand open={open} id={bodyId}>
        {opened && (
          <div
            className={cn(
              "space-y-2 text-reading",
              quiet ? "pt-1 pb-1 pl-5" : "border-t border-border p-3",
            )}
          >
            {words.raw !== undefined && (
              <p data-testid="tool-raw-name" className="text-meta text-muted-foreground">
                Tool <code className="font-mono text-foreground">{words.raw}</code>
              </p>
            )}
            {/* A subagent's calls inside hold their approvals only while this body is open. */}
            <ApprovalSlotsOpen open={open}>{children}</ApprovalSlotsOpen>
            <ToolImages part={part} size="large" className="flex flex-wrap items-start gap-2" />
            {part.state === "output-error" && (
              <pre className="overflow-x-auto font-mono text-meta whitespace-pre-wrap text-destructive">
                {part.errorText}
              </pre>
            )}
          </div>
        )}
      </Expand>
    </Tool>
  );
}

const Pre = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre
    className={cn(
      "max-h-64 overflow-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-meta whitespace-pre-wrap",
      className,
    )}
  >
    {children}
  </pre>
);

/**
 * A tool result as a card reads it: the structured output, or the plain text that stands in for
 * it. The Claude Code SDK puts no `tool_use_result` on a sidechain message, so the Claude mapper
 * falls back to the result text for every tool a subagent runs. A card renders whichever it got.
 */
const splitOutput = <T,>(output: T | string | undefined) =>
  typeof output === "string" ? { output: undefined, text: output } : { output, text: undefined };

function ShellCommand({ command, streaming }: { command: string; streaming: boolean }) {
  return (
    <Pre className="[overflow-wrap:anywhere]">
      {"$ "}
      <HighlightedCode code={command} language="shellscript" enabled={!streaming} />
    </Pre>
  );
}

function BashCard({ part }: { part: ToolPartOf<"Bash"> }) {
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  const stable = part.state === "output-available" && part.preliminary !== true;
  return (
    <ToolShell part={part} name="Bash" summary={part.input?.command}>
      {part.input?.description && (
        <p className="text-meta text-muted-foreground">{part.input.description}</p>
      )}
      <ShellCommand
        command={part.input?.command ?? ""}
        streaming={part.state === "input-streaming"}
      />
      {output && (output.stdout || output.stderr) && (
        <Pre>
          <JsonText text={output.stdout} stable={stable} />
          {output.stderr && <span className="text-destructive">{output.stderr}</span>}
        </Pre>
      )}
      {text !== undefined && (
        <Pre>
          <JsonText text={text} stable={stable} />
        </Pre>
      )}
      {output?.interrupted && <p className="text-meta text-muted-foreground">Interrupted</p>}
    </ToolShell>
  );
}

function ReadCard({ part }: { part: ToolPartOf<"Read"> }) {
  const input = part.input;
  const range =
    input?.offset !== undefined
      ? `L${input.offset}${input.limit !== undefined ? `–${input.offset + input.limit - 1}` : "+"}`
      : undefined;
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  return (
    <ToolShell
      part={part}
      name="Read"
      summary={basename(input?.file_path ?? "")}
      meta={
        range && <span className="shrink-0 font-mono text-meta text-muted-foreground">{range}</span>
      }
    >
      <p className="truncate font-mono text-meta text-muted-foreground">{input?.file_path}</p>
      {output?.type === "text" && (
        <>
          <p className="text-meta text-muted-foreground">
            {output.file.numLines} of {output.file.totalLines} lines
          </p>
          <Pre>{output.file.content}</Pre>
        </>
      )}
      {output?.type === "image" && <Pre>{json(output)}</Pre>}
      {text !== undefined && <Pre>{text}</Pre>}
    </ToolShell>
  );
}

function SearchCard({ part }: { part: ToolPartOf<"Glob"> | ToolPartOf<"Grep"> }) {
  const name = toolNameOf(part);
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  return (
    <ToolShell
      part={part}
      name={name}
      summary={part.input?.pattern}
      meta={
        output && (
          <span className="shrink-0 text-meta text-muted-foreground">{output.numFiles} files</span>
        )
      }
    >
      {part.input?.path && (
        <p className="font-mono text-meta text-muted-foreground">in {part.input.path}</p>
      )}
      {output && output.filenames.length > 0 && <Pre>{output.filenames.join("\n")}</Pre>}
      {output && "content" in output && output.content && <Pre>{output.content}</Pre>}
      {text !== undefined && <Pre>{text}</Pre>}
    </ToolShell>
  );
}

const TASK_CHIP = "shrink-0 rounded-sm border border-border px-1 text-meta text-muted-foreground";

/** A run's counts: there while the card is hovered or focused, kept in place so nothing jumps. */
const USAGE_LINE =
  "text-meta text-muted-foreground opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/tool:opacity-100 group-hover/tool:opacity-100";

/**
 * The model the run actually used: its transcript reports the wire id even when the model was
 * inherited, and the input only carries an alias the caller asked for explicitly. They are shown as
 * they come, not reconciled into one name.
 */
const subagentModel = (
  part: ToolPartOf<"Task"> | ToolPartOf<"Agent">,
  messages: readonly GramUIMessage[],
) => messages.find((message) => message.metadata?.model)?.metadata?.model ?? part.input?.model;

/** `Haiku` for `claude-haiku-4-5-20251001` or `haiku`; an id from no known family as it came. */
const modelFamily = (model: string): string => {
  const family = /(opus|sonnet|haiku|fable)/iu.exec(model)?.[1];
  return family === undefined ? model : family[0]!.toUpperCase() + family.slice(1).toLowerCase();
};

const toolUses = (n: number) => `${n} tool ${n === 1 ? "use" : "uses"}`;

/** `3 tool uses · 12.4s · 8,120 tokens`, dropping whatever the agent didn't report. */
const usageCounts = (usage: SubagentUsageData) =>
  [
    usage.toolUses === undefined ? undefined : toolUses(usage.toolUses),
    usage.durationMs === undefined ? undefined : `${(usage.durationMs / 1000).toFixed(1)}s`,
    usage.totalTokens === undefined ? undefined : `${formatCount(usage.totalTokens)} tokens`,
  ]
    .filter((piece) => piece !== undefined)
    .join(" · ");

function TaskCard({
  part,
  messages,
  usage,
  streamingIds,
  renderSubagent,
}: {
  part: ToolPartOf<"Task"> | ToolPartOf<"Agent">;
  messages: readonly GramUIMessage[];
  usage: SubagentUsageData | undefined;
  streamingIds: ReadonlySet<string>;
  renderSubagent: (message: GramUIMessage) => ReactNode;
}) {
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  // A background launch returns at once; the card runs until the subagent's transcript is done.
  const background = output?.status === "async_launched";
  const running =
    background &&
    (messages.length === 0
      ? streamingIds.size > 0
      : messages.some((message) => streamingIds.has(message.id)));
  const model = subagentModel(part, messages);
  // A finished foreground run reports richer totals with its result; the snapshot covers the rest.
  const counts = output?.status === "completed" || usage === undefined ? "" : usageCounts(usage);
  // What a live run is on; a finished card's last snapshot can still say "running".
  const live = running || part.state === "input-streaming" || part.state === "input-available";
  const note =
    live && usage?.status === "running" ? (usage.summary ?? usage.lastToolName) : undefined;
  return (
    <ToolShell
      part={part}
      name={toolNameOf(part)}
      summary={part.input?.description}
      {...(running ? { phase: "running" as const } : {})}
      meta={
        <>
          {part.input?.subagent_type && (
            <span className={TASK_CHIP}>{part.input.subagent_type}</span>
          )}
          {model && (
            <span
              data-testid="subagent-model"
              title={model}
              className={cn(TASK_CHIP, "max-w-32 truncate")}
            >
              {modelFamily(model)}
            </span>
          )}
        </>
      }
      defaultOpen
    >
      {messages.length > 0 && (
        <div className="space-y-1 border-l-2 border-border pl-3" data-testid="subagent-transcript">
          {messages.map((message) => (
            <div key={message.id}>{renderSubagent(message)}</div>
          ))}
        </div>
      )}
      {output?.status === "completed" && (
        <>
          <p className={USAGE_LINE}>
            {toolUses(output.totalToolUseCount)} · {(output.totalDurationMs / 1000).toFixed(1)}s ·{" "}
            {formatCount(output.totalTokens)} tokens
          </p>
          {messages.length === 0 &&
            output.content?.map((block, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- result blocks have no identity
              <Pre key={index}>{block.text}</Pre>
            ))}
        </>
      )}
      {counts !== "" && (
        <p data-testid="subagent-usage" className={USAGE_LINE}>
          {counts}
        </p>
      )}
      {text !== undefined && <Pre>{text}</Pre>}
      {note && <p className="truncate text-meta text-muted-foreground">{note}</p>}
      {background && (
        <p className="text-meta text-muted-foreground">
          {running ? "Running in the background" : "Ran in the background"}
        </p>
      )}
    </ToolShell>
  );
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const missingOutput = (output: unknown) =>
  output == null ||
  (typeof output === "object" && !Array.isArray(output) && Object.keys(output).length === 0);

function WebFetchCard({ part }: { part: ToolPartOf<"WebFetch"> }) {
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  return (
    <ToolShell part={part} name="WebFetch" summary={part.input?.url}>
      {part.input?.prompt && <p className="text-meta text-muted-foreground">{part.input.prompt}</p>}
      {output && (
        <>
          <p className="text-meta text-muted-foreground">
            {output.code} {output.codeText} · {formatCount(output.bytes)} bytes
          </p>
          <Pre>{output.result}</Pre>
        </>
      )}
      {text !== undefined && <Pre>{text}</Pre>}
    </ToolShell>
  );
}

function WebSearchCard({ part }: { part: ToolPartOf<"WebSearch"> }) {
  const { output, text } = splitOutput(part.state === "output-available" ? part.output : undefined);
  const links = output?.results?.flatMap((r) => (typeof r === "string" ? [] : r.content)) ?? [];
  const notes =
    output?.results?.filter((result): result is string => typeof result === "string") ?? [];
  return (
    <ToolShell part={part} name="WebSearch" summary={part.input?.query}>
      {text !== undefined && <Pre>{text}</Pre>}
      {notes.map((note, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- result notes have no identity
        <Pre key={index}>{note}</Pre>
      ))}
      {links.length > 0 && (
        <ul className="space-y-0.5 text-meta">
          {links.map((link) => (
            <li key={link.url} className="truncate">
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-link hover:underline"
              >
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </ToolShell>
  );
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

const nativeWebSummary = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  if (Array.isArray(fields.queries) && fields.queries.length > 0) {
    return fields.queries.filter((query): query is string => typeof query === "string").join("; ");
  }
  if (typeof fields.query === "string") return fields.query;
  return (
    [fields.url, fields.pattern].filter((value) => typeof value === "string").join(" · ") ||
    undefined
  );
};

function GenericCard({ part, children }: { part: AnyToolPart; children?: ReactNode }) {
  const output = splitToolImageOutput(
    part.state === "output-available" ? part.output : undefined,
  ).output;
  const nativeWeb = toolNameOf(part) === "WebSearch";
  const codexAgent = toolNameOf(part) === "codex_agent";
  const noWebResults =
    nativeWeb &&
    (missingOutput(output) || (typeof output === "object" && record(output)["results"] == null));
  const emptyRead = toolNameOf(part) === "Read" && missingOutput(output);
  const inputFields = record(part.input);
  const command = toolNameOf(part) === "Bash" ? inputFields["command"] : undefined;
  const otherInputs = Object.fromEntries(
    Object.entries(inputFields).filter(([key]) => key !== "command"),
  );
  return (
    <ToolShell
      part={part}
      name={part.title ?? toolNameOf(part)}
      label={(phase) => toolLabel(toolNameOf(part), phase, part.title)}
      summary={nativeWeb ? nativeWebSummary(part.input) : toolDetail(part)}
    >
      {children}
      {part.input !== undefined &&
        (typeof command === "string" ? (
          <>
            <ShellCommand command={command} streaming={part.state === "input-streaming"} />
            {Object.keys(otherInputs).length > 0 && (
              <Pre>
                <JsonText
                  text={json(otherInputs)}
                  serialized
                  stable={part.state !== "input-streaming"}
                />
              </Pre>
            )}
          </>
        ) : (
          <Pre>
            <JsonText
              text={json(part.input)}
              serialized
              stable={part.state !== "input-streaming"}
            />
          </Pre>
        ))}
      {codexAgent && part.state === "output-available" && (
        <div className="space-y-2 text-meta">
          <p className="text-muted-foreground">Last reported agent states</p>
          {Object.entries(record(record(output)["lastKnownAgentStates"])).map(([id, value]) => {
            const state = record(value);
            const status = String(state["status"]);
            return (
              <div key={id}>
                <p>
                  <span className="font-mono">{id}</span> · {CODEX_AGENT_STATUS[status] ?? status}
                </p>
                {typeof state["message"] === "string" && <Pre>{state["message"]}</Pre>}
              </div>
            );
          })}
        </div>
      )}
      {output !== undefined && !emptyRead && !codexAgent && (
        <Pre>
          <JsonText
            text={typeof output === "string" ? output : json(output)}
            serialized={typeof output !== "string"}
            stable={
              part.state === "output-available" &&
              part.preliminary !== true &&
              !nativeWeb &&
              toolNameOf(part) !== "Read"
            }
          />
        </Pre>
      )}
      {part.state === "output-available" && (noWebResults || emptyRead) && (
        <p className="text-meta text-muted-foreground">No result details were provided.</p>
      )}
    </ToolShell>
  );
}

const CODEX_AGENT_STATUS: Record<string, string> = {
  pendingInit: "Starting",
  running: "Running",
  interrupted: "Interrupted",
  completed: "Completed",
  errored: "Failed",
  shutdown: "Stopped",
  notFound: "Not found",
};
