import {
  FILE_EDIT_TOOLS,
  splitToolImageOutput,
  type SubagentUsageData,
  type GramUIMessage,
} from "@gram/contracts";
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Tool } from "@/components/ai-elements/tool";
import { HighlightedCode } from "@/components/ai-elements/code-block";
import { JsonText } from "./json-text";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Expand, isMarkPhase, StatusMark, Swap } from "@/motion";

import {
  basename,
  PHASE_DISPLAY,
  toolNameOf,
  toolPhase,
  type AnyToolPart,
  type ToolPartOf,
} from "./parts";
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

export function ToolCard({
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
  defaultOpen = false,
  children,
}: {
  part: AnyToolPart;
  name: string;
  summary?: ReactNode;
  meta?: ReactNode;
  /** Overrides what `part.state` implies, e.g. for a background subagent that is still running. */
  phase?: ReturnType<typeof toolPhase>;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const phase =
    phaseOverride ??
    toolPhase(
      part.state,
      part.state === "output-error" ? part.errorText : undefined,
      part.state === "output-available" && part.preliminary === true,
    );
  const display = PHASE_DISPLAY[phase];
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
      className="group/tool mb-2 rounded-(--radius-md) border-border bg-card/40"
      data-testid="tool-card"
      data-tool={name}
      data-tool-call-id={part.toolCallId}
    >
      <CollapsibleTrigger
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
      >
        {/* The mark stays mounted from pending to done, so its arc can close into the check. */}
        {/* A native title: a tooltip trigger inside the row's toggle would take its click. */}
        <span title={display.label} className="flex shrink-0">
          <Swap swapKey={isMarkPhase(phase) ? "mark" : phase}>
            {isMarkPhase(phase) ? (
              <StatusMark phase={phase} className={cn("size-3.5", display.tone)} />
            ) : (
              <display.icon aria-hidden className={cn("size-3.5", display.tone)} />
            )}
          </Swap>
        </span>
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {summary}
        </span>
        {meta}
        {/* A finished row is the common case: its check says so, and the word is for a reader. */}
        <span className={cn("shrink-0 text-xs", phase === "done" ? "sr-only" : display.tone)}>
          {display.label}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) in-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      {!open && (
        <ToolImages
          part={part}
          size="thumbnail"
          className="flex flex-wrap items-end gap-2 px-3 pb-2"
        />
      )}
      <Expand open={open} id={bodyId}>
        {opened && (
          <div className="space-y-2 border-t border-border p-3 text-sm">
            {children}
            <ToolImages part={part} size="large" className="flex flex-wrap items-start gap-2" />
            {part.state === "output-error" && (
              <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-destructive">
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
      "max-h-64 overflow-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap",
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
        <p className="text-xs text-muted-foreground">{part.input.description}</p>
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
      {output?.interrupted && <p className="text-xs text-warning">Interrupted</p>}
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
        range && <span className="shrink-0 font-mono text-xs text-muted-foreground">{range}</span>
      }
    >
      <p className="truncate font-mono text-xs text-muted-foreground">{input?.file_path}</p>
      {output?.type === "text" && (
        <>
          <p className="text-xs text-muted-foreground">
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
          <span className="shrink-0 text-xs text-muted-foreground">{output.numFiles} files</span>
        )
      }
    >
      {part.input?.path && (
        <p className="font-mono text-xs text-muted-foreground">in {part.input.path}</p>
      )}
      {output && output.filenames.length > 0 && <Pre>{output.filenames.join("\n")}</Pre>}
      {output && "content" in output && output.content && <Pre>{output.content}</Pre>}
      {text !== undefined && <Pre>{text}</Pre>}
    </ToolShell>
  );
}

const TASK_CHIP = "shrink-0 rounded-sm border border-border px-1 text-xs text-muted-foreground";

/** A run's counts: there while the card is hovered or focused, kept in place so nothing jumps. */
const USAGE_LINE =
  "text-xs text-muted-foreground opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/tool:opacity-100 group-hover/tool:opacity-100";

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
      {note && <p className="truncate text-xs text-muted-foreground">{note}</p>}
      {background && (
        <p className="text-xs text-muted-foreground">
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
      {part.input?.prompt && <p className="text-xs text-muted-foreground">{part.input.prompt}</p>}
      {output && (
        <>
          <p className="text-xs text-muted-foreground">
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
        <ul className="space-y-0.5 text-xs">
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
        <div className="space-y-2 text-xs">
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
        <p className="text-xs text-muted-foreground">No result details were provided.</p>
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
