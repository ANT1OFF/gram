import type {
  ApprovalRequest,
  McpServerProposalCard,
  PendingRequest,
  PermissionMode,
  PlanRequest,
  QuestionRequest,
  SettingsDiffRow,
  SettingsProposalCard,
  Thread,
  ThreadId,
  WorkspaceProposalCard,
} from "@gram/contracts";
import { approvalHidesText, HIDDEN_TEXT_WARNING, revealHidden } from "@gram/contracts";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ShieldQuestion,
  SquareTerminal,
  MessageCircleQuestion,
  ListChecks,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { HighlightedCommand } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { RecommendedTag } from "@/components/recommended-tag";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatKeys, useShortcut } from "@/keyboard/registry";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { AttentionPulse, PresenceItem, PresenceList, PressScale } from "@/motion";
import { Kbd, SendAnswer } from "@/orchestration/ask-choices";
import { answerKey, plainKeysReach, types } from "@/orchestration/ask-keys";
import { answeredAmong, useAskStackStore } from "@/orchestration/ask-stack-store";
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
  ALLOW_ONCE,
  DENY,
  alwaysAllowLabel,
  alwaysAllowOpenLabel,
  alwaysRuleLines,
  alwaysRules,
  approvalReceipt,
  canAlwaysAllow,
  appToolSummary,
  limitPauseAsk,
  approvalDetails,
  browserAsk,
  type BrowserAsk,
  approvalExtras,
  approvalSubject,
  mcpServerProposal,
  mustReadDetails,
  settingsProposal,
  workspaceProposal,
  type AlwaysRule,
  type ApprovalDetailField,
  type ApprovalDetails,
} from "./request-model";
import { ApprovalReceiptLine, useApprovalReceipts } from "./approval-receipt";
import { useApprovalSlots } from "./approval-slots";
import { useRespond } from "./use-respond";
import { RoleChip } from "./role-chip";

type RoleFields = Pick<Thread, "role" | "spawnedBy">;

const RequestRoleContext = createContext<RoleFields | undefined>(undefined);

const CompactContext = createContext(false);

/**
 * Cards inside render small, without the pulse, the role chip and the shortcut hints: the approvals
 * inbox answers requests of threads that aren't open, and passes every card `active={false}` so
 * an approval's keys (1, 2 and 3) stay with the focused thread's own card.
 */
export function CompactRequestCards({ children }: { children: ReactNode }) {
  return <CompactContext value={true}>{children}</CompactContext>;
}

const SheetContext = createContext(false);

/**
 * Cards inside render for the ask sheet (orchestration/ask-sheet.tsx): the sheet is their surface
 * and their scroller, so the card's own height cap, inner scroll and pulse go, and its answer row
 * sticks to the sheet's bottom edge.
 */
export function SheetRequestCards({ children }: { children: ReactNode }) {
  return <SheetContext value={true}>{children}</SheetContext>;
}

const AlwaysPreviewContext = createContext(false);

/**
 * Approval cards inside open on their "Always allow this rule…" preview: the Inbox's "Always allow
 * this rule…" leads here, so its press is not asked for twice.
 */
export function AlwaysPreviewRequestCards({ children }: { children: ReactNode }) {
  return <AlwaysPreviewContext value={true}>{children}</AlwaysPreviewContext>;
}

const HintsContext = createContext(true);

function CardKbd({ id }: { id: string }) {
  const hints = useContext(HintsContext);
  return useContext(CompactContext) || !hints ? null : <ShortcutKbd id={id} cap />;
}

/**
 * Pending requests for a thread. In a thread view each approval is drawn under the tool row that
 * waits on it (`PlacedApprovals`); elsewhere, and for a call whose row isn't drawn, approvals share
 * one paged slot above the composer. One answered from the Inbox, and held for its Undo or being
 * sent, is left out: it is answered, and Undo brings it back.
 */
export function RequestCards({
  threadId,
  requests: pending,
  focused,
  thread,
}: {
  threadId: ThreadId;
  requests: readonly PendingRequest[];
  focused: boolean;
  /** Set for an orchestrator or a worker: a card from a thread nobody watches should stand out. */
  thread?: RoleFields | undefined;
}) {
  const answered = useAskStackStore(useShallow((s) => answeredAmong(s, pending)));
  const requests = useMemo(
    () =>
      answered.length === 0 ? pending : pending.filter((request) => !answered.includes(request.id)),
    [pending, answered],
  );
  const approvals = requests.filter((request) => request.kind === "approval");
  const sheet = useContext(SheetContext);
  const compact = useContext(CompactContext);
  const drawn = useApprovalSlots();
  const slots = sheet || compact ? undefined : drawn;
  return (
    <RequestRoleContext value={thread}>
      {!sheet && <Receipt threadId={threadId} approvals={approvals} slots={slots} />}
      {slots !== undefined && approvals.length > 0 && (
        <PlacedApprovals threadId={threadId} requests={approvals} focused={focused} slots={slots} />
      )}
      <PresenceList>
        {requests.map((request) =>
          request.kind === "approval" &&
          (slots !== undefined || request !== approvals[0]) ? null : (
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

function Receipt({
  threadId,
  approvals,
  slots,
}: {
  threadId: ThreadId;
  approvals: readonly ApprovalRequest[];
  slots: ReadonlyMap<string, HTMLElement> | undefined;
}) {
  const source = useApprovalReceipts(
    useShallow((s) => {
      const receipt = s.byThread[threadId];
      return { requestId: receipt?.requestId, toolUseId: receipt?.toolUseId };
    }),
  );
  const slot = source.toolUseId === undefined ? undefined : slots?.get(source.toolUseId);
  if (slot !== undefined) {
    if (approvals.some((request) => request.id === source.requestId)) return null;
    return createPortal(<ApprovalReceiptLine threadId={threadId} />, slot);
  }
  return approvals.length === 0 ? <ApprovalReceiptLine threadId={threadId} /> : null;
}

function PlacedApprovals({
  threadId,
  requests,
  focused,
  slots,
}: {
  threadId: ThreadId;
  requests: readonly ApprovalRequest[];
  focused: boolean;
  slots: ReadonlyMap<string, HTMLElement>;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [selected, setSelected] = useState({ id: requests[0]?.id, index: 0 });
  const found = requests.findIndex((request) => request.id === selected.id);
  const index = found < 0 ? Math.min(selected.index, requests.length - 1) : found;
  const current = requests[index];
  if (current && (current.id !== selected.id || index !== selected.index)) {
    setSelected({ id: current.id, index });
  }
  const select = (id: ApprovalRequest["id"]) => {
    const at = requests.findIndex((request) => request.id === id);
    if (at >= 0 && id !== selected.id) setSelected({ id, index: at });
  };
  const revealed = useRequestRevealStore((s) =>
    s.request?.threadId === threadId ? s.request.requestId : undefined,
  );
  const revealAt = requests.findIndex((request) => request.id === revealed);
  if (revealAt >= 0 && revealAt !== index)
    setSelected({ id: requests[revealAt]?.id, index: revealAt });
  useEffect(() => {
    if (revealAt >= 0 && revealAt === index) useRequestRevealStore.getState().clear();
  }, [revealAt, index]);

  const selectedId = useRef(current?.id);
  useLayoutEffect(() => {
    selectedId.current = current?.id;
  });
  const elements = useRef(new Map<string, HTMLElement>());
  const register = useCallback((id: string, element: HTMLElement | undefined) => {
    if (element === undefined) elements.current.delete(id);
    else elements.current.set(id, element);
  }, []);
  const mayAnswer = useCallback((id: string) => {
    if (selectedId.current !== id) return false;
    const element = elements.current.get(id);
    return element !== undefined && onScreen(element);
  }, []);
  const slotOf = (request: ApprovalRequest) =>
    request.toolUseId === undefined ? undefined : slots.get(request.toolUseId);
  const waiting = requests.filter((request) => slotOf(request) === undefined);
  const shown = waiting.find((request) => request.id === current?.id) ?? waiting[0];
  const at = shown === undefined ? -1 : waiting.indexOf(shown);
  return (
    <>
      {waiting.length > 1 && (
        <nav
          aria-label="Approval navigation"
          className="mt-2 -mb-1 flex items-center justify-end gap-1"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous approval"
            disabled={at <= 0}
            onClick={() => select(waiting[at - 1]!.id)}
          >
            <ChevronLeft aria-hidden className="size-icon-chip" />
          </Button>
          <span
            aria-live="polite"
            aria-atomic="true"
            className="min-w-8 text-center font-mono text-meta text-muted-foreground"
          >
            <span className="sr-only">Approval </span>
            {at + 1}/{waiting.length}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next approval"
            disabled={at >= waiting.length - 1}
            onClick={() => select(waiting[at + 1]!.id)}
          >
            <ChevronRight aria-hidden className="size-icon-chip" />
          </Button>
        </nav>
      )}
      <div ref={setHost} data-testid="approval-fallback" />
      {requests.map((request) => {
        const slot = slotOf(request);
        return (
          <PlacedApproval
            key={request.id}
            threadId={threadId}
            request={request}
            target={slot ?? host}
            inline={slot !== undefined}
            hidden={slot === undefined && request !== shown}
            selected={request.id === current?.id}
            focused={focused}
            register={register}
            mayAnswer={mayAnswer}
            onSelect={select}
          />
        );
      })}
    </>
  );
}

function place(element: HTMLElement, target: HTMLElement | null, inline: boolean, hidden: boolean) {
  const had = focusedIn(element);
  element.dataset["inline"] = String(inline);
  element.className = inline ? "pt-1 pb-1" : "my-2";
  element.hidden = hidden;
  if (target !== null && element.parentNode !== target) target.append(element);
  if (had === undefined) return;
  if (!hidden && element.contains(had) && had.isConnected) {
    if (document.activeElement !== had) had.focus({ preventScroll: true });
  } else if (hidden) {
    handFocusOn(target ?? element, element);
  }
}

const APPROVAL_NAV = 'nav[aria-label="Approval navigation"]';

const THREAD_VIEW = "[data-thread-view]";

const KEY_AREA = `${THREAD_VIEW}, [data-approval-keys]`;

const lastFocused = new WeakMap<HTMLElement, HTMLElement>();

function watchFocus(element: HTMLElement) {
  element.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) lastFocused.set(element, event.target);
  });
  element.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && !element.contains(event.relatedTarget)) {
      lastFocused.delete(element);
    }
  });
}

function focusedIn(element: HTMLElement): HTMLElement | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    return element.contains(active) ? active : undefined;
  }
  return lastFocused.get(element);
}

function handFocusOn(near: Element, from: HTMLElement) {
  lastFocused.delete(from);
  const scope = near.closest(THREAD_VIEW);
  if (scope === null) return;
  setTimeout(() => {
    if (!focusLost()) return;
    const shown = [...scope.querySelectorAll<HTMLElement>('[data-testid="approval-place"]')].filter(
      (each) => each !== from && !each.hidden && onScreen(each),
    );
    const next = shown.find((each) => each.hasAttribute("data-selected")) ?? shown[0];
    const card = next?.querySelector<HTMLElement>('[data-testid="approval-card"]');
    if (card !== undefined && card !== null) {
      card.focus({ preventScroll: true });
      if (document.activeElement === card) return;
    }
    focusIfConnected(scope.querySelector('textarea[aria-label="Message"]'));
  }, 0);
}

/**
 * Whether any of `element` is on screen now: connected, in nothing hidden, collapsed or inert, and
 * inside the window and every ancestor that clips it (the transcript's scroller, a folded body).
 * Measured when asked, so it is never a stale report.
 */
export function onScreen(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden], [inert]") !== null) return false;
  const rect = element.getBoundingClientRect();
  let top = Math.max(rect.top, 0);
  let left = Math.max(rect.left, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let right = Math.min(rect.right, window.innerWidth);
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    left = Math.max(left, clip.left);
    bottom = Math.min(bottom, clip.bottom);
    right = Math.min(right, clip.right);
  }
  return bottom > top && right > left;
}

function PlacedApproval({
  threadId,
  request,
  target,
  inline,
  hidden,
  selected,
  focused,
  register,
  mayAnswer,
  onSelect,
}: {
  threadId: ThreadId;
  request: ApprovalRequest;
  target: HTMLElement | null;
  inline: boolean;
  hidden: boolean;
  selected: boolean;
  focused: boolean;
  register: (id: string, element: HTMLElement | undefined) => void;
  mayAnswer: (id: string) => boolean;
  onSelect: (id: ApprovalRequest["id"]) => void;
}) {
  const [element] = useState(() => {
    const div = document.createElement("div");
    div.setAttribute("data-testid", "approval-place");
    watchFocus(div);
    return div;
  });
  const id = request.id;
  useLayoutEffect(() => place(element, target, inline, hidden), [element, target, inline, hidden]);
  useLayoutEffect(() => {
    element.toggleAttribute("data-selected", selected);
  }, [element, selected]);
  const view = useRef<Element | null>(null);
  useLayoutEffect(() => {
    view.current = element.closest(THREAD_VIEW) ?? target?.closest(THREAD_VIEW) ?? view.current;
  });
  useLayoutEffect(() => {
    register(id, element);
    return () => {
      register(id, undefined);
      if (focusedIn(element) !== undefined) handFocusOn(view.current ?? element, element);
      element.remove();
    };
  }, [element, id, register]);
  const canAnswer = useCallback(() => mayAnswer(id), [mayAnswer, id]);
  return createPortal(
    <HintsContext value={selected}>
      <div onFocus={() => onSelect(id)}>
        <ApprovalCard
          threadId={threadId}
          request={request}
          active={focused && selected}
          canAnswer={canAnswer}
        />
      </div>
    </HintsContext>,
    element,
  );
}

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
  if (current && (current.id !== selected.id || index !== selected.index)) {
    setSelected({ id: current.id, index });
  }
  const step = (next: number) => setSelected({ id: requests[next]?.id, index: next });
  const revealed = useRequestRevealStore((s) =>
    s.request?.threadId === threadId ? s.request.requestId : undefined,
  );
  const revealAt = requests.findIndex((request) => request.id === revealed);
  if (revealAt >= 0 && revealAt !== index)
    setSelected({ id: requests[revealAt]?.id, index: revealAt });
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
            <ChevronLeft aria-hidden className="size-icon-chip" />
          </Button>
          <span
            aria-live="polite"
            aria-atomic="true"
            className="min-w-8 text-center font-mono text-meta text-muted-foreground"
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
            <ChevronRight aria-hidden className="size-icon-chip" />
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

function CardShell({
  testId,
  requestId,
  icon,
  title,
  children,
  footer,
  answerKeys = false,
  ref,
}: {
  testId: string;
  requestId: string;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  answerKeys?: boolean;
  ref?: Ref<HTMLElement> | undefined;
}) {
  const onKeyDown = answerKeys
    ? (event: KeyboardEvent<HTMLElement>) => {
        if (answerKey(event.nativeEvent, event.currentTarget)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    : undefined;
  const thread = useContext(RequestRoleContext);
  const compact = useContext(CompactContext);
  const sheet = useContext(SheetContext);
  if (sheet) {
    return (
      <section
        ref={ref}
        data-testid={testId}
        data-request-id={requestId}
        data-sheet
        aria-label={typeof title === "string" ? title : undefined}
        className="flex flex-col text-reading"
        onKeyDown={onKeyDown}
      >
        <h3 className="mb-2 flex items-center gap-2 font-medium">
          {icon}
          {title}
        </h3>
        <div data-testid="request-card-body">{children}</div>
        {footer && (
          <div
            data-testid="ask-sheet-answer-row"
            className="sticky bottom-0 -mx-4 mt-3 flex flex-wrap items-center gap-2 border-t border-edge bg-popover px-4 py-2.5"
          >
            {footer}
          </div>
        )}
      </section>
    );
  }
  const card = (
    <section
      ref={ref}
      data-testid={testId}
      data-request-id={requestId}
      data-surface="card"
      data-compact={compact}
      aria-label={typeof title === "string" ? title : undefined}
      tabIndex={compact ? undefined : -1}
      onKeyDown={onKeyDown}
      className={cn(
        "border border-status-needs-mark/70 bg-card text-reading outline-none focus-visible:focus-ring",
        compact
          ? "rounded-(--radius-md) p-2"
          : // On a phone the card grows with its question and the transcript scrolls: a nested
            // half-height scroller there hides choices behind a second swipe.
            "flex max-h-[calc(var(--pane-height,100vh)*0.5)] flex-col rounded-(--radius-lg) p-3 shadow-(--shadow-raised) phone:max-h-none",
      )}
    >
      <h3
        className={cn(
          "flex shrink-0 items-center gap-2 font-medium",
          compact ? "mb-1.5 text-meta" : "mb-2",
        )}
      >
        {icon}
        {title}
        {!compact && <RoleChip thread={thread} testId="request-role" />}
      </h3>
      {compact ? (
        children
      ) : (
        <div
          data-testid="request-card-body"
          className="-m-1 min-h-0 overflow-y-auto p-1 phone:overflow-visible"
        >
          {children}
        </div>
      )}
      {footer && (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2",
            compact ? "mt-2" : "mt-3",
            "phone:flex-col phone:items-stretch phone:[&_button]:h-11 phone:[&_button]:w-full phone:[&_kbd]:hidden",
          )}
        >
          {footer}
        </div>
      )}
    </section>
  );
  if (compact) return card;
  return (
    <AttentionPulse active inset trigger={testId} className="rounded-(--radius-lg)">
      {card}
    </AttentionPulse>
  );
}

function DetailFields({
  fields,
  mono = false,
}: {
  fields: readonly ApprovalDetailField[];
  mono?: boolean;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className={cn("min-w-0 break-words", mono && "font-mono")}>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const DETAIL_TEXT =
  "overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 text-meta break-words whitespace-pre-wrap";

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
        className="group flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className="size-icon-chip shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="approval-details-body" className="gram-collapse">
        {details.kind === "json" ? (
          <pre className={cn(DETAIL_TEXT, "mt-1 font-mono")}>{details.text}</pre>
        ) : details.kind === "issue" ? (
          <div className="mt-1 flex flex-col gap-2 text-meta">
            <DetailFields fields={details.fields} />
            <p data-testid="approval-issue-body" className={DETAIL_TEXT}>
              {details.body}
            </p>
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-2 text-meta">
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

function DiffTable({ rows, fresh = false }: { rows: readonly SettingsDiffRow[]; fresh?: boolean }) {
  return (
    <table className="w-full border-collapse text-meta">
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
        <p data-testid="settings-reason" className="text-meta break-words text-muted-foreground">
          Why: {reason}
        </p>
      )}
      {children}
      {notes !== undefined && notes.length > 0 && (
        <ul data-testid="settings-notes" className="text-meta text-muted-foreground">
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
          <h4 className="pb-1 text-meta text-muted-foreground">Projects</h4>
          <ul className="flex flex-col text-meta">
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

function McpRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="contents">
      <dt className="py-1 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 border-border py-1 break-words">{children}</dd>
    </div>
  );
}

function McpValue({
  children,
  testId,
  strong = false,
}: {
  children: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <code
      data-testid={testId}
      className={cn(
        "inline-block min-h-[1lh] min-w-2 rounded-(--radius-2xs) border border-border bg-muted/50 px-1 align-top font-mono break-all whitespace-pre-wrap",
        strong && "font-medium",
      )}
    >
      {children}
    </code>
  );
}

const MCP_TRANSPORT = {
  stdio: "stdio",
  http: "HTTP (streamable)",
  sse: "SSE",
} as const;

function McpServerDiff({
  card,
  summary,
}: {
  card: McpServerProposalCard;
  summary: string | undefined;
}) {
  const mono = "font-mono break-all";
  return (
    <div data-testid="mcp-server-diff" className="flex flex-col gap-2">
      <ProposalWords summary={summary} reason={card.reason} notes={card.notes}>
        {card.transport === "stdio" && (
          <p data-testid="mcp-runs-program" className="flex items-start gap-1.5 font-medium">
            <SquareTerminal aria-hidden className="mt-0.5 size-icon-row shrink-0" />
            Runs a program on this machine, as you, whenever an agent session starts its MCP
            servers.
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-meta [&>div>*]:border-t [&>div>*]:border-border">
          <McpRow label="Name">
            <span className={mono}>{card.name}</span>
          </McpRow>
          <McpRow label="Transport">{MCP_TRANSPORT[card.transport]}</McpRow>
          {card.url !== undefined && (
            <McpRow label="URL" testId="mcp-url">
              <span className={mono}>{card.url}</span>
            </McpRow>
          )}
          {card.host !== undefined && (
            <McpRow label="Host" testId="mcp-host">
              <span className={cn(mono, "font-medium")}>{card.host}</span>
            </McpRow>
          )}
          {card.headers !== undefined && (
            <McpRow label="Headers">
              <ul>
                {card.headers.map((header) => (
                  <li key={header.name} data-testid="mcp-header" className={mono}>
                    {header.name}: <McpValue testId="mcp-header-value">{header.value}</McpValue>
                  </li>
                ))}
              </ul>
            </McpRow>
          )}
          {card.command !== undefined && (
            <McpRow label="Command" testId="mcp-command">
              <span className="flex flex-wrap gap-1">
                {[card.command, ...(card.args ?? [])].map((word, i) => (
                  <McpValue key={i} testId="mcp-arg" strong={i === 0}>
                    {word}
                  </McpValue>
                ))}
              </span>
            </McpRow>
          )}
          {card.env !== undefined && (
            <McpRow label="Env">
              <ul>
                {card.env.map((variable) => (
                  <li key={variable.name} data-testid="mcp-env" className={mono}>
                    {variable.name}=<McpValue testId="mcp-env-value">{variable.value}</McpValue>
                  </li>
                ))}
              </ul>
            </McpRow>
          )}
          <McpRow label="Scope">{card.scopeText}</McpRow>
          {card.targets.map((target) => (
            <McpRow key={target.target} label={target.label} testId="mcp-target">
              <span className="flex flex-col">
                <span>{target.where}</span>
                {target.replaces !== undefined && (
                  <span data-testid="mcp-replaces" className="text-muted-foreground">
                    Replaces its {target.replaces.scope} {target.replaces.transport} server{" "}
                    <span className={cn(mono, "whitespace-pre-wrap line-through")}>
                      {target.replaces.url ?? target.replaces.commandLine ?? card.name}
                    </span>
                    {target.replaces.carriesValues &&
                      ", and its env or header values, which aren't shown"}
                  </span>
                )}
              </span>
            </McpRow>
          ))}
        </dl>
      </ProposalWords>
    </div>
  );
}

/**
 * What an Allow covers when the card leads with one field of the input: the description as a plain
 * sentence, that field, the rest of the arguments on a quiet line under it, and the whole input
 * under Details. Two
 * requests for the same command with different arguments read differently here, as the inbox keeps
 * them apart.
 */
export function ApprovalInput({ request }: { request: ApprovalRequest }) {
  const extras = approvalExtras(request);
  const more =
    Object.keys(request.input).length > 1 &&
    approvalSubject(request) !== revealHidden(JSON.stringify(request.input));
  const hides = approvalHidesText(request);
  return (
    <>
      {request.allowWithheld !== undefined && (
        <p
          data-testid="approval-withheld"
          role="alert"
          className="mb-2 text-meta text-status-needs-mark"
        >
          {request.allowWithheld}
        </p>
      )}
      {hides && (
        <p
          data-testid="approval-hidden-warning"
          role="alert"
          className="mb-2 text-meta text-status-needs-mark"
        >
          {HIDDEN_TEXT_WARNING}
        </p>
      )}
      {request.description && (
        <p data-testid="approval-description" className="mb-2">
          {revealHidden(request.description)}
        </p>
      )}
      <pre
        data-testid="approval-subject"
        className="overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-meta whitespace-pre-wrap"
      >
        {typeof request.input["command"] === "string" && !hides ? (
          <HighlightedCommand code={request.input["command"]} />
        ) : (
          approvalSubject(request)
        )}
      </pre>
      {extras.length > 0 && (
        <p
          data-testid="approval-extras"
          className="mt-1 font-mono text-meta break-all text-muted-foreground"
        >
          {extras.map((field, index) => (
            <span key={field.label}>
              {index > 0 && " · "}
              {field.label}: <span className="text-foreground">{field.value}</span>
            </span>
          ))}
        </p>
      )}
      {more && <ApprovalDetailsFold details={approvalDetails(request)} />}
    </>
  );
}

function BrowserAskBody({ request, ask }: { request: ApprovalRequest; ask: BrowserAsk }) {
  const compact = useContext(CompactContext);
  return (
    <>
      {ask.message !== undefined && (
        <p data-testid="approval-summary" className={cn("break-words", compact && "text-meta")}>
          {ask.message}
        </p>
      )}
      {ask.fields.length > 0 && (
        <div
          data-testid="approval-browser-fields"
          className={cn("text-meta", ask.message !== undefined && "mt-1")}
        >
          <DetailFields fields={ask.fields} mono />
        </div>
      )}
      {request.decisionReason && (
        <p className="mt-2 text-meta text-muted-foreground">{request.decisionReason}</p>
      )}
      {!compact && <ApprovalDetailsFold details={approvalDetails(request)} />}
    </>
  );
}

export function ApprovalCard({
  threadId,
  request,
  active,
  canAnswer,
}: {
  threadId: ThreadId;
  request: ApprovalRequest;
  active: boolean;
  /**
   * Asked at each press of the card's keys (1, 2, 3): whether this card may take it now. A card
   * drawn under its row passes whether it is the selected card and on screen; without it, `active`
   * alone decides, as above the composer.
   */
  canAnswer?: (() => boolean) | undefined;
}) {
  const { respond, pending } = useRespond(threadId, request);
  const compact = useContext(CompactContext);
  const summary = appToolSummary(request);
  const pause = limitPauseAsk(request);
  const settings = pause === undefined ? settingsProposal(request) : undefined;
  const workspace = pause === undefined ? workspaceProposal(request) : undefined;
  const mcpServer = pause === undefined ? mcpServerProposal(request) : undefined;
  const plainTool =
    pause === undefined &&
    settings === undefined &&
    workspace === undefined &&
    mcpServer === undefined;
  const browser = plainTool ? browserAsk(request) : undefined;
  const rules = alwaysRules(request);
  const canAlways = canAlwaysAllow(request);
  const preview = useContext(AlwaysPreviewContext);
  const [confirming, setConfirming] = useState(preview && canAlways);
  const plain = plainTool;
  const allow = (scope: "once" | "always") =>
    void respond(
      { kind: "approval", decision: "allow", scope },
      plain ? approvalReceipt(request, scope) : undefined,
    );
  const deny = () =>
    void respond(
      { kind: "approval", decision: "deny", scope: "once" },
      plain ? approvalReceipt(request, "deny") : undefined,
    );
  const always = () => (confirming ? allow("always") : setConfirming(true));

  const cardRef = useRef<HTMLElement>(null);
  const keysReach = () => {
    const card = cardRef.current;
    const focus = document.activeElement;
    if (focus === null || focus === document.body) return true;
    if (card === null) return false;
    const view = card.closest(KEY_AREA);
    const paging = focus.closest(APPROVAL_NAV) !== null && focus.closest(KEY_AREA) === view;
    if (card.contains(focus) || paging) return !types(focus);
    return view !== null && plainKeysReach(focus, view);
  };
  const mayAnswer = () => keysReach() && (canAnswer?.() ?? true);
  const hides = approvalHidesText(request);
  const withheld = request.allowWithheld !== undefined;

  useShortcut(
    {
      id: "approval.allow",
      keys: "1",
      label: ALLOW_ONCE,
      group: "Thread",
      once: true,
      when: mayAnswer,
      run: () => allow("once"),
    },
    active && pause === undefined && !hides && !withheld,
  );
  useShortcut(
    {
      id: "approval.always",
      keys: "2",
      label: alwaysAllowOpenLabel(1),
      group: "Thread",
      when: () => canAlways && mayAnswer(),
      once: true,
      run: always,
    },
    active && pause === undefined && !hides,
  );
  useShortcut(
    {
      id: "approval.deny",
      keys: "3",
      label: DENY,
      group: "Thread",
      once: true,
      when: mayAnswer,
      run: deny,
    },
    active && pause === undefined,
  );

  return (
    <CardShell
      ref={cardRef}
      testId="approval-card"
      requestId={request.id}
      icon={<ShieldQuestion aria-hidden className="size-icon-row text-status-needs-mark" />}
      title={
        pause !== undefined
          ? pause.lead
          : settings !== undefined
            ? "Change Gram settings?"
            : workspace !== undefined
              ? workspace.action === "create"
                ? `Create workspace “${workspace.workspace.name}”?`
                : `Change workspace “${workspace.workspace.name}”?`
              : mcpServer !== undefined
                ? `${mcpServer.action === "replace" ? "Replace" : "Add"} MCP server “${mcpServer.name}”?`
                : revealHidden(request.title ?? browser?.title ?? `Allow ${request.displayName}?`)
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
              variant="outline"
              data-testid="approval-allow"
              disabled={pending}
              onClick={() => allow("once")}
            >
              {pause.keep}
            </Button>
          </>
        ) : (
          <>
            {!withheld && (
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
                      : mcpServer !== undefined
                        ? mcpServer.action === "replace"
                          ? "Replace server"
                          : "Add server"
                        : ALLOW_ONCE}{" "}
                  {!hides && <CardKbd id="approval.allow" />}
                </Button>
              </PressScale>
            )}
            {canAlways && (
              <Button
                size="sm"
                variant="outline"
                data-testid="approval-always"
                aria-expanded={confirming}
                disabled={pending}
                onClick={always}
              >
                {confirming ? alwaysAllowLabel(rules.length) : alwaysAllowOpenLabel(rules.length)}{" "}
                {!hides && <CardKbd id="approval.always" />}
              </Button>
            )}
            {confirming && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="approval-always-back"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="approval-deny"
              disabled={pending}
              onClick={deny}
              // A bare word on a phone reads as a caption under the stacked buttons: outline it.
              className="phone:border-border dark:phone:border-input"
            >
              {DENY} <CardKbd id="approval.deny" />
            </Button>
          </>
        )
      }
    >
      {pause !== undefined ? (
        <p data-testid="approval-summary" className={cn("break-words", compact && "text-meta")}>
          {pause.description}
        </p>
      ) : settings !== undefined ? (
        <SettingsDiff card={settings} summary={summary} />
      ) : workspace !== undefined ? (
        <WorkspaceDiff card={workspace} summary={summary} />
      ) : mcpServer !== undefined ? (
        <McpServerDiff card={mcpServer} summary={summary} />
      ) : browser !== undefined ? (
        <BrowserAskBody request={request} ask={browser} />
      ) : summary === undefined ? (
        <ApprovalInput request={request} />
      ) : (
        <>
          <p data-testid="approval-summary" className={cn("break-words", compact && "text-meta")}>
            {summary}
          </p>
          {(!compact || mustReadDetails(request)) && (
            <ApprovalDetailsFold
              details={approvalDetails(request)}
              open={mustReadDetails(request)}
            />
          )}
        </>
      )}
      {request.decisionReason && browser === undefined && (
        <p className="mt-1 text-meta text-muted-foreground">{request.decisionReason}</p>
      )}
      {request.blockedPath && (
        <p className="mt-1 font-mono text-meta text-warning">
          Outside the workspace: {request.blockedPath}
        </p>
      )}
      {canAlways && confirming && <AlwaysRules rules={rules} />}
    </CardShell>
  );
}

function AlwaysRules({ rules }: { rules: readonly AlwaysRule[] }) {
  const compact = useContext(CompactContext);
  const save = alwaysAllowLabel(rules.length);
  return (
    <div
      data-testid="approval-always-rules"
      role="group"
      aria-label="What Always allow saves"
      className={cn(
        "mt-3 flex flex-col gap-2 rounded-(--radius-sm) border border-border bg-muted/30 p-2.5",
        compact ? "text-meta" : "text-reading",
      )}
    >
      <p className="font-medium">{save}?</p>
      <ul className="flex flex-col gap-2">
        {rules.map((rule, index) => {
          const lines = alwaysRuleLines(rule);
          return (
            <li
              key={`${rule.rule}:${index}`}
              data-testid="approval-always-rule"
              data-reach={rule.reach}
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta">
                <dt className="text-muted-foreground">Rule</dt>
                <dd data-testid="approval-always-rule-text">
                  <code className="font-mono break-all">{lines.rule}</code>
                </dd>
                <dt className="text-muted-foreground">Applies to</dt>
                <dd data-testid="approval-always-applies">{lines.appliesTo}</dd>
                {lines.savedIn !== undefined && (
                  <>
                    <dt className="text-muted-foreground">Saved in</dt>
                    <dd data-testid="approval-always-saved" className="break-all">
                      {lines.savedIn}
                    </dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
      </ul>
      <p className="text-meta text-muted-foreground">
        Nothing is saved until you choose {save}. {ALLOW_ONCE} saves nothing.
      </p>
    </div>
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

  const [index, setIndex] = useState(0);
  const count = request.questions.length;
  const page = Math.min(index, count - 1);
  const q = request.questions[page];
  const last = page === count - 1;

  return (
    <CardShell
      testId="question-card"
      requestId={request.id}
      icon={<MessageCircleQuestion aria-hidden className="size-icon-row text-status-needs-mark" />}
      title="The agent has a question"
      answerKeys
      footer={
        <>
          {last ? (
            <SendAnswer
              testId="question-card-send"
              disabled={!complete || pending}
              title={complete ? undefined : count > 1 ? "Answer each question" : "Pick an answer"}
              label={count > 1 ? "Send answers" : "Send answer"}
              hint={formatKeys("mod+enter")}
              onSend={submit}
            />
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
                "flex items-center gap-1 rounded-sm border border-transparent bg-muted px-1.5 py-0.5 text-meta text-muted-foreground phone:min-h-11 phone:px-3",
                i === page && "border-primary bg-primary/10 text-foreground",
              )}
            >
              {answerFor(each.question).length > 0 && (
                <Check aria-hidden className="size-icon-row" />
              )}
              {each.header}
            </button>
          ))}
          <span className="ml-auto text-meta text-muted-foreground">
            {page + 1} of {count}
          </span>
        </nav>
      )}
      {q && (
        <fieldset key={q.question} className="space-y-1.5">
          <legend className="mb-1">
            {count === 1 && (
              <span className="mr-2 rounded-sm bg-muted px-1 text-meta text-muted-foreground">
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
            hints
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
 * make, said in a tag and never picked for the user. With `hints`, each shows the number key that
 * picks it (`answerKey`).
 */
export function ChoiceList({
  question,
  options,
  multiSelect,
  recommended,
  value,
  onChange,
  hints = false,
}: {
  question: string;
  options: readonly { readonly label: string; readonly description?: string | undefined }[];
  multiSelect: boolean;
  recommended?: string | undefined;
  value: Choice;
  onChange: (choice: Choice) => void;
  hints?: boolean;
}) {
  const hint = (index: number) =>
    hints && index < 9 ? (
      <Kbd hidden className="mt-0.5 ml-auto shrink-0">
        {index + 1}
      </Kbd>
    ) : null;
  const name = useId();
  const optionId = (index: number) => `${name}-${index}`;
  const fieldId = `${name}-other`;
  const pick = (label: string) => onChange(toggleOption(value, label, multiSelect));
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
        <div
          key={option.label}
          className="flex items-start gap-2 rounded-(--radius-sm) px-1 py-0.5 hover:bg-muted/50"
        >
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
            <input
              id={optionId(index)}
              type={multiSelect ? "checkbox" : "radio"}
              name={name}
              className="mt-1 accent-(--accent)"
              data-choice-index={index}
              checked={value.selected.includes(option.label)}
              onChange={() => pick(option.label)}
            />
            <span className="min-w-0 flex-1">
              {option.label}
              {option.label === recommended && (
                <RecommendedTag testId="choice-recommended" className="ml-1.5" />
              )}
              {option.description !== undefined && (
                <span className="block text-meta text-muted-foreground">{option.description}</span>
              )}
            </span>
          </label>
          {hint(index)}
        </div>
      ))}
      <div className="flex items-center gap-2 px-1 py-0.5">
        <input
          type={multiSelect ? "checkbox" : "radio"}
          name={name}
          aria-label="Other"
          className="accent-(--accent)"
          data-choice-index={options.length}
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
          className="min-w-0 flex-1 rounded-(--radius-sm) border border-input bg-transparent px-2 py-1 text-reading outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value.other}
          onFocus={() => {
            if (!multiSelect && !value.otherChosen) onChange(chooseOther(value, true, false));
          }}
          onChange={(event) => onChange(typeOther(value, event.target.value, multiSelect))}
          onKeyDown={stepOut}
        />
        {hint(options.length)}
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
  const inSheet = useContext(SheetContext);
  const [stage, setStage] = useState<"review" | "approve" | "reject">("review");
  const [mode, setMode] = useState<PermissionMode>("acceptEdits");
  const [message, setMessage] = useState("");

  return (
    <CardShell
      testId="plan-card"
      requestId={request.id}
      icon={<ListChecks aria-hidden className="size-icon-row text-status-needs-mark" />}
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
      <div
        className={cn(
          "rounded-(--radius-sm) bg-muted/30 px-3 py-2",
          !inSheet && "max-h-80 overflow-auto",
        )}
      >
        <MessageResponse>{request.plan}</MessageResponse>
      </div>
      {request.planFilePath && (
        <p className="mt-1 font-mono text-meta text-muted-foreground">{request.planFilePath}</p>
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
              <span className="block text-reading">{option.label}</span>
              <span className="block text-meta text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>
      )}
      {stage === "reject" && (
        <textarea
          aria-label="What should change?"
          placeholder="What should change?"
          className="mt-3 min-h-16 w-full rounded-(--radius-sm) border border-input bg-transparent p-2 text-reading outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      )}
    </CardShell>
  );
}
