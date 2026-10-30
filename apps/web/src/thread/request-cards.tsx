import type {
  ApprovalRequest,
  PendingRequest,
  PermissionMode,
  PlanRequest,
  QuestionRequest,
  RequestAnswer,
  SettingsDiffRow,
  SettingsProposalCard,
  Thread,
  ThreadId,
  WorkspaceProposalCard,
} from "@gram/contracts";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ShieldQuestion,
  MessageCircleQuestion,
  ListChecks,
  Star,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useApi } from "@/api/context";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useShortcut } from "@/keyboard/registry";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { AttentionPulse, PresenceItem, PresenceList, PressScale } from "@/motion";
import { useRequestRevealStore } from "@/stores/reveal";

import {
  NO_CHOICE,
  choiceAnswer,
  chooseOther,
  toggleOption,
  typeOther,
  type Choice,
} from "./choice-model";
import {
  appToolSummary,
  limitPauseAsk,
  approvalDetails,
  approvalExtras,
  approvalSubject,
  mustReadDetails,
  settingsProposal,
  workspaceProposal,
  type ApprovalDetailField,
  type ApprovalDetails,
} from "./request-model";
import { RoleChip } from "./role-chip";

type RoleFields = Pick<Thread, "role" | "spawnedBy">;

/** The asking thread's orchestration fields, so every card's heading can carry its role. */
const RequestRoleContext = createContext<RoleFields | undefined>(undefined);

/** Whether cards render small, for the approvals inbox. */
const CompactContext = createContext(false);

/**
 * Cards inside render small, without the pulse, the role chip and the shortcut hints: the approvals
 * inbox answers requests of threads that aren't open, and passes every card `active={false}` so
 * Enter and Escape stay with the focused thread's own card.
 */
export function CompactRequestCards({ children }: { children: ReactNode }) {
  return <CompactContext value={true}>{children}</CompactContext>;
}

/** A card's shortcut hint, which the inbox leaves out as its cards own no shortcuts. */
function CardKbd({ id }: { id: string }) {
  return useContext(CompactContext) ? null : <ShortcutKbd id={id} className="opacity-70" />;
}

/** Pending requests for a thread, with approvals sharing one paged slot. */
export function RequestCards({
  threadId,
  requests,
  focused,
  thread,
}: {
  threadId: ThreadId;
  requests: readonly PendingRequest[];
  focused: boolean;
  /** Set for an orchestrator or a worker: a card from a thread nobody watches should stand out. */
  thread?: RoleFields | undefined;
}) {
  const approvals = requests.filter((request) => request.kind === "approval");
  return (
    <RequestRoleContext value={thread}>
      {/* A card lands, and an answered one folds away, so the transcript above never jumps. */}
      <PresenceList>
        {requests.map((request) =>
          request.kind === "approval" && request !== approvals[0] ? null : (
            <PresenceItem
              key={request.kind === "approval" ? "approvals" : request.id}
              className="my-2"
            >
              {request.kind === "approval" ? (
                <ApprovalQueue threadId={threadId} requests={approvals} active={focused} />
              ) : request.kind === "question" ? (
                <QuestionCard threadId={threadId} request={request} />
              ) : (
                <PlanCard threadId={threadId} request={request} />
              )}
            </PresenceItem>
          ),
        )}
      </PresenceList>
    </RequestRoleContext>
  );
}

/** Keeps each request's in-flight answer and expanded details while another approval is shown. */
function ApprovalQueue({
  threadId,
  requests,
  active,
}: {
  threadId: ThreadId;
  requests: readonly ApprovalRequest[];
  active: boolean;
}) {
  const [selected, setSelected] = useState({ id: requests[0]?.id, index: 0 });
  const found = requests.findIndex((request) => request.id === selected.id);
  const index = found < 0 ? Math.min(selected.index, requests.length - 1) : found;
  const current = requests[index];
  // Resolving an earlier request must not change which command the user is reviewing.
  if (current && (current.id !== selected.id || index !== selected.index)) {
    setSelected({ id: current.id, index });
  }
  const step = (next: number) => setSelected({ id: requests[next]?.id, index: next });
  // A Needs you jump to one of these shows it, whichever was being reviewed.
  const revealed = useRequestRevealStore((s) =>
    s.request?.threadId === threadId ? s.request.requestId : undefined,
  );
  const revealAt = requests.findIndex((request) => request.id === revealed);
  if (revealAt >= 0 && revealAt !== index)
    setSelected({ id: requests[revealAt]?.id, index: revealAt });
  // Shown, it is taken, so stepping on to another approval stays where it is put.
  useEffect(() => {
    if (revealAt >= 0 && revealAt === index) useRequestRevealStore.getState().clear();
  }, [revealAt, index]);
  return (
    <div role="group" aria-label="Pending approvals">
      {requests.length > 1 && (
        <nav aria-label="Approval navigation" className="mb-1 flex items-center justify-end gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous approval"
            disabled={index === 0}
            onClick={() => step(index - 1)}
          >
            <ChevronLeft aria-hidden className="size-3.5" />
          </Button>
          <span
            aria-live="polite"
            aria-atomic="true"
            className="min-w-8 text-center font-mono text-xs text-muted-foreground"
          >
            <span className="sr-only">Approval </span>
            {index + 1}/{requests.length}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next approval"
            disabled={index === requests.length - 1}
            onClick={() => step(index + 1)}
          >
            <ChevronRight aria-hidden className="size-3.5" />
          </Button>
        </nav>
      )}
      {requests.map((request, i) => (
        <div key={request.id} hidden={i !== index}>
          <ApprovalCard threadId={threadId} request={request} active={active && i === index} />
        </div>
      ))}
    </div>
  );
}

function useRespond(threadId: ThreadId, request: PendingRequest) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const respond = async (answer: RequestAnswer) => {
    if (pending) return;
    setPending(true);
    try {
      await api.respond(threadId, request.id, answer);
    } catch (error) {
      console.error("respond", error);
      setPending(false);
    }
  };
  return { respond, pending };
}

function CardShell({
  testId,
  requestId,
  icon,
  title,
  children,
  footer,
}: {
  testId: string;
  /** What a Needs you jump finds the card by. */
  requestId: string;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const thread = useContext(RequestRoleContext);
  const compact = useContext(CompactContext);
  const card = (
    <section
      data-testid={testId}
      data-request-id={requestId}
      data-surface="card"
      data-compact={compact}
      aria-label={typeof title === "string" ? title : undefined}
      className={cn(
        "border border-status-needs/50 bg-card text-sm",
        compact
          ? "rounded-(--radius-md) p-2"
          : // Above the composer, the card keeps to a share of the pane: its body scrolls and its
            // buttons stay in view, however tall the request or short the window.
            "flex max-h-[calc(var(--pane-height,100vh)*0.5)] flex-col rounded-(--radius-lg) p-3 shadow-(--shadow-raised)",
      )}
    >
      <h3
        className={cn(
          "flex shrink-0 items-center gap-2 font-medium",
          compact ? "mb-1.5 text-xs" : "mb-2",
        )}
      >
        {icon}
        {title}
        {!compact && <RoleChip thread={thread} testId="request-role" />}
      </h3>
      {compact ? (
        children
      ) : (
        // The inset keeps focus rings inside the scroll box from being cut off.
        <div data-testid="request-card-body" className="-m-1 min-h-0 overflow-y-auto p-1">
          {children}
        </div>
      )}
      {footer && (
        <div
          className={cn("flex shrink-0 flex-wrap items-center gap-2", compact ? "mt-2" : "mt-3")}
        >
          {footer}
        </div>
      )}
    </section>
  );
  if (compact) return card;
  return (
    <AttentionPulse active trigger={testId} className="rounded-(--radius-lg)">
      {card}
    </AttentionPulse>
  );
}

function DetailFields({ fields }: { fields: readonly ApprovalDetailField[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-words">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const DETAIL_TEXT =
  "overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 text-xs break-words whitespace-pre-wrap";

/**
 * An app tool's input, folded away under its description, except an issue's, which is open: the
 * user is approving that exact text for a shared repo. All of it is plain text, never markdown.
 */
/** `open` shows the details from the start, for an approval that must be read before it is answered. */
function ApprovalDetailsFold({
  details,
  open = false,
}: {
  details: ApprovalDetails;
  open?: boolean;
}) {
  return (
    <Collapsible className="mt-2" defaultOpen={open || details.kind === "issue"}>
      <CollapsibleTrigger
        data-testid="approval-details"
        className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="approval-details-body" className="gram-collapse">
        {details.kind === "json" ? (
          <pre className={cn(DETAIL_TEXT, "mt-1 font-mono")}>{details.text}</pre>
        ) : details.kind === "issue" ? (
          <div className="mt-1 flex flex-col gap-2 text-xs">
            <DetailFields fields={details.fields} />
            <p data-testid="approval-issue-body" className={DETAIL_TEXT}>
              {details.body}
            </p>
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-2 text-xs">
            <DetailFields fields={details.fields} />
            {details.scope.length > 0 && (
              <div>
                <h4 className="text-muted-foreground">Scope</h4>
                <ul className="font-mono">
                  {details.scope.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h4 className="text-muted-foreground">Brief</h4>
              <p data-testid="approval-brief" className={cn(DETAIL_TEXT, "mt-0.5")}>
                {details.brief}
              </p>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A change by chat's rows: each setting as it is now and as it would be, or for something new only
 * what it will be. Every row is shown, since approving applies exactly these.
 */
function DiffTable({ rows, fresh = false }: { rows: readonly SettingsDiffRow[]; fresh?: boolean }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th scope="col" className="pr-3 pb-1 font-normal">
            Setting
          </th>
          {!fresh && (
            <th scope="col" className="pr-3 pb-1 font-normal">
              Now
            </th>
          )}
          <th scope="col" className="pb-1 font-normal">
            {fresh ? "Value" : "After"}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={`${row.key} ${row.label}`}
            data-testid="settings-diff-row"
            className="border-t border-border align-top"
          >
            <th scope="row" className="py-1 pr-3 text-left font-normal break-words">
              {row.label}
            </th>
            {!fresh && (
              <td
                className={cn(
                  "py-1 pr-3 break-words text-muted-foreground",
                  row.before !== null && "line-through",
                )}
              >
                {row.before ?? "Not there"}
              </td>
            )}
            <td
              className={cn(
                "py-1 break-words",
                row.after === null ? "text-muted-foreground" : "font-medium",
              )}
            >
              {row.after ?? "Removed"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The agent's reason and the server's notes on a change by chat, as plain text. */
function ProposalWords({
  summary,
  reason,
  children,
  notes,
}: {
  summary: string | undefined;
  reason: string | undefined;
  children: ReactNode;
  notes: readonly string[] | undefined;
}) {
  return (
    <>
      {summary !== undefined && (
        <p data-testid="approval-summary" className="break-words">
          {summary}
        </p>
      )}
      {reason !== undefined && (
        <p data-testid="settings-reason" className="text-xs break-words text-muted-foreground">
          Why: {reason}
        </p>
      )}
      {children}
      {notes !== undefined && notes.length > 0 && (
        <ul data-testid="settings-notes" className="text-xs text-muted-foreground">
          {notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A `settings_propose` card's change set: each setting as it is now and as it would be, every row
 * shown, since Apply changes exactly these. The reason and notes are the agent's and the server's,
 * as plain text.
 */
function SettingsDiff({
  card,
  summary,
}: {
  card: SettingsProposalCard;
  summary: string | undefined;
}) {
  return (
    <div data-testid="settings-diff" className="flex flex-col gap-2">
      <ProposalWords summary={summary} reason={card.reason} notes={card.notes}>
        <DiffTable rows={card.rows} />
      </ProposalWords>
    </div>
  );
}

const PROJECT_CHANGE = { added: "Adds", removed: "Removes", kept: "Keeps" } as const;

/**
 * A `workspace_create` or `workspace_update` card: the workspace's projects by path, each marked
 * with what happens to it, the home and any Gram doesn't know yet, then its settings. A new
 * workspace lists what it will have; a change shows before → after.
 */
function WorkspaceDiff({
  card,
  summary,
}: {
  card: WorkspaceProposalCard;
  summary: string | undefined;
}) {
  const fresh = card.action === "create";
  return (
    <div data-testid="workspace-diff" className="flex flex-col gap-2">
      <ProposalWords summary={summary} reason={card.reason} notes={card.notes}>
        <div>
          <h4 className="pb-1 text-xs text-muted-foreground">Projects</h4>
          <ul className="flex flex-col text-xs">
            {card.projects.map((project) => (
              <li
                key={project.root}
                data-testid="workspace-project"
                className="flex items-baseline gap-2 border-t border-border py-1"
              >
                {!fresh && (
                  <span className="w-14 shrink-0 text-muted-foreground">
                    {PROJECT_CHANGE[project.change]}
                  </span>
                )}
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "font-mono break-all",
                      project.change === "removed" && "text-muted-foreground line-through",
                      project.change === "added" && !fresh && "font-medium",
                    )}
                  >
                    {project.root}
                  </span>
                  <span className="text-muted-foreground">
                    {[
                      project.name,
                      ...(project.home === true ? ["home"] : []),
                      ...(project.unregistered === true ? ["new to Gram, added as a project"] : []),
                    ].join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {card.rows.length > 0 && <DiffTable rows={card.rows} fresh={fresh} />}
      </ProposalWords>
    </div>
  );
}

/**
 * What an Allow covers when the card leads with one field of the input: that field, the rest of the
 * arguments on a quiet line under it, the description, and the whole input under Details. Two
 * requests for the same command with different arguments read differently here, as the inbox keeps
 * them apart.
 */
export function ApprovalInput({ request }: { request: ApprovalRequest }) {
  const extras = approvalExtras(request);
  // More to the input than the line it leads with, if only a description: Details has all of it.
  const more =
    Object.keys(request.input).length > 1 &&
    approvalSubject(request) !== JSON.stringify(request.input);
  return (
    <>
      <pre className="overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
        {approvalSubject(request)}
      </pre>
      {extras.length > 0 && (
        <p
          data-testid="approval-extras"
          className="mt-1 font-mono text-[11px] break-all text-muted-foreground"
        >
          {extras.map((field, index) => (
            <span key={field.label}>
              {index > 0 && " · "}
              {field.label}: <span className="text-foreground">{field.value}</span>
            </span>
          ))}
        </p>
      )}
      {request.description && (
        <p className="mt-2 text-xs text-muted-foreground">{request.description}</p>
      )}
      {more && <ApprovalDetailsFold details={approvalDetails(request)} />}
    </>
  );
}

export function ApprovalCard({
  threadId,
  request,
  active,
}: {
  threadId: ThreadId;
  request: ApprovalRequest;
  active: boolean;
}) {
  const { respond, pending } = useRespond(threadId, request);
  const compact = useContext(CompactContext);
  const summary = appToolSummary(request);
  // The limit threshold's ask: Deny pauses new workers until the reset, Allow keeps going.
  const pause = limitPauseAsk(request);
  // A settings change by chat: the diff is the whole card, and Apply changes applies it.
  const settings = pause === undefined ? settingsProposal(request) : undefined;
  // A workspace made or changed by chat: the same, with its projects above its settings.
  const workspace = pause === undefined ? workspaceProposal(request) : undefined;
  // Outward app tools restrict scopes to `["once"]`; absent means every scope is allowed. A browse
  // card's "always" is the host's place in Settings → Agent may browse, not a permission rule.
  const browseHost = request.browseHost;
  const canAlways =
    (browseHost !== undefined || request.suggestions.length > 0) &&
    (request.scopes?.includes("always") ?? true);
  const alwaysLabel = browseHost === undefined ? "Allow always" : `Always for ${browseHost}`;
  const allow = (scope: "once" | "always") =>
    void respond({ kind: "approval", decision: "allow", scope });
  const deny = () => void respond({ kind: "approval", decision: "deny", scope: "once" });

  useShortcut(
    {
      id: "approval.allow",
      keys: "enter",
      label: "Allow",
      group: "Thread",
      once: true,
      run: () => allow("once"),
    },
    active && pause === undefined,
  );
  useShortcut(
    {
      id: "approval.always",
      keys: "alt+enter",
      label: "Allow always",
      group: "Thread",
      when: () => canAlways,
      once: true,
      run: () => allow("always"),
    },
    active && pause === undefined,
  );
  useShortcut(
    { id: "approval.deny", keys: "escape", label: "Deny", group: "Thread", once: true, run: deny },
    active && pause === undefined,
  );

  return (
    <CardShell
      testId="approval-card"
      requestId={request.id}
      icon={<ShieldQuestion aria-hidden className="size-4 text-status-needs" />}
      title={
        pause !== undefined
          ? pause.lead
          : settings !== undefined
            ? "Change Gram settings?"
            : workspace !== undefined
              ? workspace.action === "create"
                ? `Create workspace “${workspace.workspace.name}”?`
                : `Change workspace “${workspace.workspace.name}”?`
              : `Allow ${request.displayName}?`
      }
      footer={
        pause !== undefined ? (
          <>
            <PressScale>
              <Button size="sm" data-testid="approval-deny" disabled={pending} onClick={deny}>
                {pause.pause}
              </Button>
            </PressScale>
            <Button
              size="sm"
              variant="secondary"
              data-testid="approval-allow"
              disabled={pending}
              onClick={() => allow("once")}
            >
              {pause.keep}
            </Button>
          </>
        ) : (
          <>
            <PressScale>
              <Button
                size="sm"
                data-testid="approval-allow"
                disabled={pending}
                onClick={() => allow("once")}
              >
                {workspace?.action === "create"
                  ? "Create workspace"
                  : settings !== undefined || workspace !== undefined
                    ? "Apply changes"
                    : "Allow"}{" "}
                <CardKbd id="approval.allow" />
              </Button>
            </PressScale>
            {canAlways && (
              <Button
                size="sm"
                variant="secondary"
                data-testid="approval-always"
                disabled={pending}
                onClick={() => allow("always")}
              >
                {alwaysLabel} <CardKbd id="approval.always" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="approval-deny"
              disabled={pending}
              onClick={deny}
            >
              Deny <CardKbd id="approval.deny" />
            </Button>
          </>
        )
      }
    >
      {pause !== undefined ? (
        <p data-testid="approval-summary" className={cn("break-words", compact && "text-xs")}>
          {pause.description}
        </p>
      ) : settings !== undefined ? (
        <SettingsDiff card={settings} summary={summary} />
      ) : workspace !== undefined ? (
        <WorkspaceDiff card={workspace} summary={summary} />
      ) : summary === undefined ? (
        <ApprovalInput request={request} />
      ) : (
        <>
          <p data-testid="approval-summary" className={cn("break-words", compact && "text-xs")}>
            {summary}
          </p>
          {/* The inbox answers at a glance; the whole input is a click away in the thread. */}
          {(!compact || mustReadDetails(request)) && (
            <ApprovalDetailsFold
              details={approvalDetails(request)}
              open={mustReadDetails(request)}
            />
          )}
        </>
      )}
      {request.decisionReason && (
        <p className="mt-1 text-xs text-muted-foreground">{request.decisionReason}</p>
      )}
      {request.blockedPath && (
        <p className="mt-1 font-mono text-xs text-warning">
          Outside the workspace: {request.blockedPath}
        </p>
      )}
    </CardShell>
  );
}

export function QuestionCard({
  threadId,
  request,
}: {
  threadId: ThreadId;
  request: QuestionRequest;
}) {
  const { respond, pending } = useRespond(threadId, request);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  const answerFor = (question: string) => choiceAnswer(choices[question] ?? NO_CHOICE);
  const complete = request.questions.every((q) => answerFor(q.question).length > 0);

  const submit = () =>
    void respond({
      kind: "question",
      answers: Object.fromEntries(
        request.questions.map((q) => [q.question, answerFor(q.question)]),
      ),
    });

  // One question at a time: four of them with four options each pushed the transcript off screen.
  const [index, setIndex] = useState(0);
  const count = request.questions.length;
  const page = Math.min(index, count - 1);
  const q = request.questions[page];
  const last = page === count - 1;

  return (
    <CardShell
      testId="question-card"
      requestId={request.id}
      icon={<MessageCircleQuestion aria-hidden className="size-4 text-status-needs" />}
      title="The agent has a question"
      footer={
        <>
          {last ? (
            <Button size="sm" disabled={!complete || pending} onClick={submit}>
              Send answers
            </Button>
          ) : (
            <Button size="sm" data-testid="question-next" onClick={() => setIndex(page + 1)}>
              Next
            </Button>
          )}
          {count > 1 && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="question-previous"
              disabled={page === 0}
              onClick={() => setIndex(page - 1)}
            >
              Previous
            </Button>
          )}
        </>
      }
    >
      {count > 1 && (
        <nav aria-label="Questions" className="mb-3 flex flex-wrap items-center gap-1">
          {request.questions.map((each, i) => (
            <button
              key={each.question}
              type="button"
              aria-current={i === page ? "step" : undefined}
              onClick={() => setIndex(i)}
              className={cn(
                "flex items-center gap-1 rounded-sm border border-transparent bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase",
                i === page && "border-primary bg-primary/10 text-foreground",
              )}
            >
              {answerFor(each.question).length > 0 && <Check aria-hidden className="size-3" />}
              {each.header}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {page + 1} of {count}
          </span>
        </nav>
      )}
      {q && (
        <fieldset key={q.question} className="space-y-1.5">
          <legend className="mb-1">
            {count === 1 && (
              <span className="mr-2 rounded-sm bg-muted px-1 text-[11px] text-muted-foreground uppercase">
                {q.header}
              </span>
            )}
            {q.question}
          </legend>
          <ChoiceList
            question={q.question}
            options={q.options}
            multiSelect={q.multiSelect}
            value={choices[q.question] ?? NO_CHOICE}
            onChange={(choice) => setChoices((prev) => ({ ...prev, [q.question]: choice }))}
          />
        </fieldset>
      )}
    </CardShell>
  );
}

/**
 * A question's choices, as radios or, when several may be picked, checkboxes, with "Other…" last
 * for an answer in the user's own words. On a single-select question Other is one of the radios,
 * so an answer is an option or the typed text, never both. The thread's question card and an
 * orchestrator's open questions answer through it; `recommended` names the choice the agent would
 * make.
 */
export function ChoiceList({
  question,
  options,
  multiSelect,
  recommended,
  value,
  onChange,
}: {
  question: string;
  options: readonly { readonly label: string; readonly description?: string | undefined }[];
  multiSelect: boolean;
  recommended?: string | undefined;
  value: Choice;
  onChange: (choice: Choice) => void;
}) {
  const name = useId();
  const optionId = (index: number) => `${name}-${index}`;
  const fieldId = `${name}-other`;
  const pick = (label: string) => onChange(toggleOption(value, label, multiSelect));
  // Focus sits in the field while Other is the chosen radio, so the arrows that would leave the
  // radio leave the field instead.
  const stepOut = (event: KeyboardEvent<HTMLInputElement>) => {
    if (multiSelect || options.length === 0) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = event.key === "ArrowUp" ? options.length - 1 : 0;
    pick(options[index]!.label);
    document.getElementById(optionId(index))?.focus();
  };
  return (
    <>
      {options.map((option, index) => (
        <label
          key={option.label}
          className="flex cursor-pointer items-start gap-2 rounded-(--radius-sm) px-1 py-0.5 hover:bg-muted/50"
        >
          <input
            id={optionId(index)}
            type={multiSelect ? "checkbox" : "radio"}
            name={name}
            className="mt-1 accent-(--accent)"
            checked={value.selected.includes(option.label)}
            onChange={() => pick(option.label)}
          />
          <span>
            {option.label}
            {option.label === recommended && (
              <span
                data-testid="choice-recommended"
                title="Recommended"
                className="ml-1 inline-flex align-[-1px] text-status-needs"
              >
                <Star aria-hidden className="size-3 fill-current" />
                <span className="sr-only">(recommended)</span>
              </span>
            )}
            {option.description !== undefined && (
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            )}
          </span>
        </label>
      ))}
      <div className="flex items-center gap-2 px-1 py-0.5">
        <input
          type={multiSelect ? "checkbox" : "radio"}
          name={name}
          aria-label="Other"
          className="accent-(--accent)"
          checked={value.otherChosen}
          onChange={(event) => {
            onChange(chooseOther(value, event.target.checked, multiSelect));
            if (event.target.checked) document.getElementById(fieldId)?.focus();
          }}
        />
        <input
          id={fieldId}
          type="text"
          aria-label={`Other answer: ${question}`}
          placeholder="Other…"
          className="min-w-0 flex-1 rounded-(--radius-sm) border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value.other}
          onFocus={() => {
            if (!multiSelect && !value.otherChosen) onChange(chooseOther(value, true, false));
          }}
          onChange={(event) => onChange(typeOther(value, event.target.value, multiSelect))}
          onKeyDown={stepOut}
        />
      </div>
    </>
  );
}

const PLAN_MODES: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: "acceptEdits", label: "Accept edits", hint: "Edits apply; commands still ask" },
  { mode: "auto", label: "Auto", hint: "The agent decides what needs approval" },
  { mode: "default", label: "Ask", hint: "Ask before edits and commands" },
  { mode: "bypassPermissions", label: "Bypass", hint: "Never ask" },
];

export function PlanCard({ threadId, request }: { threadId: ThreadId; request: PlanRequest }) {
  const { respond, pending } = useRespond(threadId, request);
  const [stage, setStage] = useState<"review" | "approve" | "reject">("review");
  const [mode, setMode] = useState<PermissionMode>("acceptEdits");
  const [message, setMessage] = useState("");

  return (
    <CardShell
      testId="plan-card"
      requestId={request.id}
      icon={<ListChecks aria-hidden className="size-4 text-status-needs" />}
      title="Review the plan"
      footer={
        stage === "review" ? (
          <>
            <Button size="sm" onClick={() => setStage("approve")}>
              Approve…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStage("reject")}>
              Reject…
            </Button>
          </>
        ) : stage === "approve" ? (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => void respond({ kind: "plan", decision: "approve", mode })}
            >
              Start in {PLAN_MODES.find((m) => m.mode === mode)?.label}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStage("review")}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void respond({
                  kind: "plan",
                  decision: "reject",
                  ...(message.trim() ? { message: message.trim() } : {}),
                })
              }
            >
              Send feedback
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStage("review")}>
              Back
            </Button>
          </>
        )
      }
    >
      <div className="max-h-80 overflow-auto rounded-(--radius-sm) bg-muted/30 px-3 py-2">
        <MessageResponse>{request.plan}</MessageResponse>
      </div>
      {request.planFilePath && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">{request.planFilePath}</p>
      )}
      {stage === "approve" && (
        <div
          role="radiogroup"
          aria-label="Mode after approval"
          className="mt-3 grid grid-cols-2 gap-1.5"
        >
          {PLAN_MODES.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={mode === option.mode}
              onClick={() => setMode(option.mode)}
              className={cn(
                "rounded-(--radius-sm) border border-border px-2 py-1 text-left",
                mode === option.mode && "border-primary bg-primary/10",
              )}
            >
              <span className="block text-sm">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>
      )}
      {stage === "reject" && (
        <textarea
          aria-label="What should change?"
          placeholder="What should change?"
          className="mt-3 min-h-16 w-full rounded-(--radius-sm) border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      )}
    </CardShell>
  );
}
