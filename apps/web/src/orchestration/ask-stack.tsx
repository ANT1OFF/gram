import {
  helperOn,
  type MemoryQuestion,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Hand,
  ListChecks,
  MessageCircleQuestion,
  ShieldQuestion,
} from "lucide-react";
import * as m from "motion/react-m";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatKeys } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import {
  DrawnCheck,
  PresenceItem,
  PresenceList,
  PulseOnce,
  useArrivals,
  useMotionLevel,
  usePresetTransition,
} from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useLayoutStore } from "@/stores/layout";
import { OptionGallery } from "@/thread/mock-visuals";

import { clock, inOverlay, plainKeysReach, SETTLE_MS, types } from "./ask-keys";
import { AskChoices, Kbd, MoreText, plainHint, SendAnswer } from "./ask-choices";
import { holdAnswer, type SendAction } from "./ask-answer";
import {
  answerRule,
  replyAnswer,
  replyChips,
  stepIndex,
  type Ask,
  type AskMember,
  choiceLayout,
  type AskOption,
} from "./ask-model";
import { answersInSheet, openAskSheet, useAskSheet } from "./ask-sheet-store";
import { useAskStackStore } from "./ask-stack-store";
import { useDerivedAsks } from "./needs-you-store";

export interface WorkspaceAsks {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  /** What the stack shows: held, sending and just-sent answers taken out. */
  readonly asks: readonly Ask[];
}

/**
 * Every workspace's asks, read live from its threads and its open questions, as the board reads
 * its own. The sidebar's count, every orchestrator's stack and Quiet read this one list, which
 * `useDerivedAsks` derives once for the window. Asks put away for Later are left out unless
 * `withLater`, which Needs you passes to list them apart.
 */
export function useWorkspaceAsks({
  withLater = false,
}: { withLater?: boolean } = {}): readonly WorkspaceAsks[] {
  return useDerivedAsks((s) => (withLater ? s.withLater : s.asks));
}

/** A workspace's open questions its asks still hold, its own and its workers' forwarded ones. */
export interface AskedQuestions {
  readonly questions: readonly MemoryQuestion[];
  readonly workerQuestions: readonly WorkerQuestion[];
}

const NO_QUESTIONS: AskedQuestions = { questions: [], workerQuestions: [] };

/** The open questions of `asks`: what is answered, held or set aside is already gone from them. */
export const askedQuestions = (asks: readonly Ask[]): AskedQuestions => ({
  questions: asks.flatMap((ask) => (ask.memory === undefined ? [] : [ask.memory.question])),
  workerQuestions: asks.flatMap((ask) => (ask.worker === undefined ? [] : [ask.worker.question])),
});

/**
 * `workspaceId`'s open questions as its stack still asks them: the Board's band, the orchestrator's
 * banner and the workspace's status count these, so an answered or snoozed one leaves them all.
 */
export function useAskedQuestions(workspaceId: WorkspaceId | undefined): AskedQuestions {
  const asks = useDerivedAsks((s) => s.asks.find((w) => w.workspaceId === workspaceId)?.asks);
  return useMemo(() => (asks === undefined ? NO_QUESTIONS : askedQuestions(asks)), [asks]);
}

/** What the sidebar's count says: every workspace's asks, and the one to open first. */
export const askTotals = (
  all: readonly WorkspaceAsks[],
): { readonly count: number; readonly first: WorkspaceAsks | undefined } => ({
  count: all.reduce((sum, w) => sum + w.asks.length, 0),
  first: all.find((w) => w.asks.length > 0),
});

const ICON = { approval: ShieldQuestion, question: MessageCircleQuestion, plan: ListChecks };

/** Opens a thread in the grid and goes there, as a sidebar row would. */
export function useOpenThread() {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
}

/** The reply field of a question answered in words, with the helper's drafts as chips. */
export function ReplyField({
  ask,
  current,
  onSend,
  inputRef,
  hint,
}: {
  ask: Ask;
  current: boolean;
  onSend: (text: string) => void;
  inputRef: (element: HTMLInputElement | null) => void;
  /** The key Send answer takes, when keys reach it: ⏎ in the field. */
  hint?: string | undefined;
}) {
  const api = useApi();
  const id = ask.ids[0] ?? ask.key;
  // Kept outside the ask, so stepping away or undoing doesn't lose what was typed.
  const text = useAskStackStore((s) => s.replies[id] ?? "");
  const setText = (value: string) => useAskStackStore.getState().setReply(id, value);
  const own = useRef<HTMLInputElement | null>(null);
  const helpers = useServerSettings((s) =>
    s.settings !== undefined && helperOn(s.settings, "suggest")
      ? JSON.stringify(s.settings.helpers ?? {})
      : undefined,
  );
  const request = ask.freeForm?.request;
  // Off or not allowed, there is nothing to show: no chips and no placeholder for them. Asked
  // again once the helpers' settings change, as with a consent given since.
  const { data: replies = [] } = useQuery({
    queryKey: [
      "request-replies",
      request?.threadId,
      request?.requestId,
      ask.group?.entries[0].request,
      helpers,
    ],
    queryFn: () => api.requestReplies(request!.threadId, request!.requestId),
    enabled: helpers !== undefined && current && request !== undefined,
    staleTime: (query) => ((query.state.data?.length ?? 0) > 0 ? Infinity : 30_000),
    retry: false,
  });
  const chips = helpers === undefined ? [] : replyChips(replies);
  const submit = () => {
    const reply = text.trim();
    if (reply !== "") onSend(reply);
  };
  return (
    <div className="mt-1.5 grid gap-1.5">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Suggested replies">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-testid="ask-reply-chip"
              onClick={() => {
                setText(chip);
                own.current?.focus();
              }}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={(element) => {
            own.current = element;
            inputRef(element);
          }}
          data-testid="ask-reply-input"
          aria-label={`Reply: ${ask.lead}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Reply"
          className="h-7 min-w-0 flex-1 rounded-(--radius-md) border border-border bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <SendAnswer
          type="submit"
          testId="ask-reply-send"
          disabled={text.trim() === ""}
          hint={current ? hint : undefined}
        />
      </form>
    </div>
  );
}

const DETAIL_TEXT =
  "overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap";

/** Everything an Allow covers that the ask's lines don't: where each member runs, the whole input. */
function AskDetailsBody({ ask, where }: { ask: Ask; where: readonly AskMember[] }) {
  return (
    <div className="mt-1 grid gap-1.5 text-xs">
      {where.length > 0 && (
        <ul className="grid gap-0.5 text-muted-foreground">
          {where.map((member) => (
            <li
              key={`${member.title}\0${member.checkout?.path}`}
              data-testid="ask-member"
              className="min-w-0 break-all"
            >
              <span className="text-foreground">{member.title}</span>
              {member.project !== undefined && ` · ${member.project}`}
              <span className="font-mono">
                {" "}
                · {member.checkout?.path}
                {member.checkout?.branch !== undefined && ` (${member.checkout.branch})`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ask.details?.kind === "json" && <pre className={DETAIL_TEXT}>{ask.details.text}</pre>}
      {ask.details?.kind === "spawn" && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {ask.details.fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
          {ask.details.scope.length > 0 && (
            <p className="font-mono text-[11px]">{ask.details.scope.join(", ")}</p>
          )}
          <pre className={DETAIL_TEXT}>{ask.details.brief}</pre>
        </>
      )}
      {ask.details?.kind === "issue" && <pre className={DETAIL_TEXT}>{ask.details.body}</pre>}
    </div>
  );
}

/**
 * Where each member runs and the whole input, behind Details; `open` shows them without the fold,
 * as a detail pane does.
 */
export function AskDetails({ ask, open = false }: { ask: Ask; open?: boolean }) {
  const where = ask.members.filter((member) => member.checkout !== undefined);
  if (where.length === 0 && ask.details === undefined) return null;
  if (open) {
    return (
      <div data-testid="ask-details-body">
        <AskDetailsBody ask={ask} where={where} />
      </div>
    );
  }
  return (
    <Collapsible className="mt-1">
      <CollapsibleTrigger
        data-testid="ask-details"
        className="group flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-(--dur-fast) group-data-[panel-open]:rotate-90"
        />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="ask-details-body" className="gram-collapse">
        <AskDetailsBody ask={ask} where={where} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Which keys answer now: plain ones, the composer's modifiers, or none while focus types elsewhere. */
type KeyHints = "plain" | "composer" | undefined;

const hintOf = (hints: KeyHints, index: number): string | undefined => {
  if (hints === undefined || index > 8) return undefined;
  return hints === "plain" ? plainHint(index) : formatKeys(`alt+${index + 1}`);
};

/** What sends the picked choice: ⌘⏎, in the open and in an empty composer alike. */
const SEND_KEYS = "mod+enter";

function AskItem({
  ask,
  current,
  hints,
  arrived,
  problem,
  picked,
  onPick,
  onChoose,
  onReply,
  replyRef,
}: {
  ask: Ask;
  current: boolean;
  hints: KeyHints;
  arrived: boolean;
  problem: string | undefined;
  /** The choice picked and not sent yet. */
  picked: number | undefined;
  onPick: (index: number) => void;
  onChoose: (option: AskOption) => void;
  onReply: (text: string) => void;
  replyRef: (element: HTMLInputElement | null) => void;
}) {
  const level = useMotionLevel();
  const spring = usePresetTransition("gentle");
  const Icon = ICON[ask.icon];
  const rise = arrived && level === "full";
  const pick = answerRule(ask.options) === "pick";
  const sendHint = current && hints !== undefined ? formatKeys(SEND_KEYS) : undefined;
  const pickedOption = picked === undefined ? undefined : ask.options[picked];
  return (
    <m.div
      initial={rise ? { y: 14 } : false}
      animate={{ y: 0 }}
      transition={spring}
      data-testid="ask-item"
      data-ask-key={ask.key}
      data-current={current || undefined}
      // Focusable from a jump (the overview's "asks you"), where the stack's plain keys answer it.
      tabIndex={-1}
      // In a narrow chat (a worker kept beside it), the answers wrap under the question rather than
      // squeeze it to a letter a line.
      className="flex flex-wrap items-start gap-2.5 px-3.5 pt-1 pb-2.5 outline-none"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-status-needs-mark" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm break-words" data-testid="ask-title">
          {ask.lead}
          {ask.command !== undefined && (
            <>
              {" "}
              <code
                data-testid="ask-command"
                title={ask.command}
                className="inline font-mono text-[0.8rem] break-all"
              >
                {ask.command}
              </code>
            </>
          )}
          {ask.count > 1 && <span className="text-muted-foreground"> × {ask.count}</span>}
        </p>
        {ask.extras.length > 0 && (
          <p
            data-testid="ask-extras"
            className="font-mono text-[11px] break-all text-muted-foreground"
          >
            {ask.extras.map((field, index) => (
              <span key={field.label}>
                {index > 0 && " · "}
                {field.label}: <span className="text-foreground">{field.value}</span>
              </span>
            ))}
          </p>
        )}
        <p className="truncate text-xs text-muted-foreground" data-testid="ask-context">
          {ask.context}
        </p>
        {ask.description !== undefined && ask.description.trim() !== "" && (
          <MoreText
            text={ask.description}
            lines={2}
            testId="ask-description"
            className="text-xs text-muted-foreground"
          />
        )}
        <AskDetails ask={ask} />
        {ask.freeForm !== undefined && (
          <ReplyField
            ask={ask}
            current={current}
            onSend={onReply}
            inputRef={replyRef}
            hint={hints === undefined ? undefined : "⏎"}
          />
        )}
        {problem !== undefined && (
          <p role="alert" data-testid="ask-problem" className="mt-1 text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
      {/* Each option's screenshot and "Open mock", above the options they show. */}
      {ask.visuals !== undefined && (
        <OptionGallery
          threadId={ask.visuals.threadId}
          options={ask.visuals.options}
          recommended={ask.visuals.recommended}
          mock={ask.visuals.mock}
          className="basis-full pl-6.5"
        />
      )}
      {ask.options.length > 0 && (
        <AskChoices
          options={ask.options}
          hintOf={(index) =>
            !current
              ? undefined
              : // A verb picked by its key is sent by ⌘⏎: its hint says so.
                !pick && index === picked && sendHint !== undefined
                ? sendHint
                : hintOf(hints, index)
          }
          onChoose={onChoose}
          picked={picked}
          onPick={onPick}
          testId="ask-option"
          rest="ghost"
          // Choices go under the question, with Send answer after them; a row of verbs sits to
          // the right of the question while it fits.
          className={
            pick || choiceLayout(ask.options) === "list"
              ? "basis-full pl-6.5"
              : "ml-auto justify-end"
          }
        >
          {pick && (
            <SendAnswer
              testId="ask-send"
              disabled={pickedOption === undefined}
              title={pickedOption === undefined ? "Pick a choice first" : undefined}
              hint={sendHint}
              onSend={() => {
                if (pickedOption !== undefined) onChoose(pickedOption);
              }}
            />
          )}
        </AskChoices>
      )}
    </m.div>
  );
}

/** How long an ask a jump lands on stays ringed. */
const RING_MS = 1_600;

/**
 * Brings the ask `key` into view in the dock at `root`, rings it for a moment and gives it focus,
 * where the stack's plain keys answer it: what a jump from Needs you or a Board chip lands on.
 */
const ringAsk = (root: HTMLElement, key: string) => {
  const look = () => {
    const item = [...root.querySelectorAll<HTMLElement>('[data-testid="ask-item"]')].find(
      (element) => element.dataset["askKey"] === key,
    );
    if (item === undefined) return;
    item.scrollIntoView({ block: "nearest" });
    item.setAttribute("data-needs-you-flash", "true");
    item.focus({ preventScroll: true });
    setTimeout(() => item.removeAttribute("data-needs-you-flash"), RING_MS);
  };
  // After the step to it has drawn.
  requestAnimationFrame(look);
};

/** What the stack's keys reach across: the thread's pane, or the view it is docked in. */
const SCOPE = "[data-pane-root], [data-ask-scope]";

const COMPOSER = 'textarea[aria-label="Message"]';

/**
 * Where focus is for the stack's keys: this pane's composer, which takes them only with a modifier;
 * nothing that types or activates, which takes them plain; or anywhere else, which never does.
 */
const focusReach = (target: Element | null, pane: Element): "composer" | "plain" | undefined => {
  if (target !== null && pane.contains(target) && !inOverlay(target) && target.matches(COMPOSER)) {
    return "composer";
  }
  return plainKeysReach(target, pane) ? "plain" : undefined;
};

/** Whether the pane's composer holds something to send: words or an attachment. */
const composerHolds = (pane: Element, threadId: ThreadId | undefined): boolean =>
  (threadId !== undefined && (useDraftStore.getState().text[threadId] ?? "") !== "") ||
  pane.querySelector('[data-testid="attachment-chip"]') !== null;

/**
 * Every ask waiting in the orchestrator's workspace, docked above its composer: the top one open,
 * the rest behind its stepper. Equal approvals are one ask, and the orchestrator's own requests and
 * open questions are asks too. One answer rule, as everywhere: a question's choice is picked (a
 * click, or 1–9 with focus on nothing that types, ⌥1–9 in the composer), then sent with Send answer
 * or ⌘⏎; an approval's verbs act on a click. An answer waits `UNDO_MS` before it goes out.
 *
 * It is the one answer surface while nothing else answers: with the ask sheet open on one of its
 * asks, or a request card in the thread above answering one, it folds to a single "N more waiting"
 * row, and leaves the thread's own cards' asks out of its list.
 */
export function AskStack({
  workspaceId,
  composerThreadId,
  focused,
}: {
  workspaceId: WorkspaceId | undefined;
  /** The thread whose composer sits under the stack and takes its keys with a modifier; none on the Board. */
  composerThreadId?: ThreadId | undefined;
  focused: boolean;
}) {
  const all = useWorkspaceAsks();
  const held = useAskStackStore((s) => s.held);
  const problems = useAskStackStore((s) => s.problems);
  const api = useApi();
  const queryClient = useQueryClient();
  const open = useOpenThread();
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRefs = useRef(new Map<string, HTMLInputElement>());
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState<{ key: string | undefined; index: number }>({
    key: undefined,
    index: 0,
  });
  // The choice picked on each ask and not sent yet.
  const [picks, setPicks] = useState<Readonly<Record<string, number>>>({});
  const setPick = (key: string, index: number | undefined) =>
    setPicks((was) => {
      if (was[key] === index) return was;
      const next = { ...was };
      if (index === undefined) delete next[key];
      else next[key] = index;
      return next;
    });

  const here = all.find((w) => w.workspaceId === workspaceId);
  const every = here?.asks ?? NO_ASKS;
  const elsewhere = all.filter((w) => w.workspaceId !== workspaceId && w.asks.length > 0);
  // What the thread above answers in its own request cards (a plan, a request to read in full):
  // each ask in one place, so those are left out here.
  const inline = useMemo(
    () =>
      composerThreadId === undefined
        ? NO_KEYS
        : new Set(
            every
              .filter(
                (ask) =>
                  answersInSheet(ask) &&
                  ask.group?.entries.some((entry) => entry.threadId === composerThreadId) === true,
              )
              .map((ask) => ask.key),
          ),
    [every, composerThreadId],
  );
  const asks = useMemo(
    () => (inline.size === 0 ? every : every.filter((ask) => !inline.has(ask.key))),
    [every, inline],
  );
  // The ask the sheet has open, when it is one of this workspace's.
  const sheetId = useAskSheet((s) =>
    s.target !== undefined && s.target.workspaceId === workspaceId ? s.target.id : undefined,
  );
  const sheetKey =
    sheetId === undefined ? undefined : every.find((ask) => ask.ids.includes(sheetId))?.key;
  // Folded while something else answers: the sheet, or the thread's own card. "Show" unfolds it
  // until what folded it changes.
  const foldedBy =
    sheetKey !== undefined
      ? `sheet:${sheetKey}`
      : inline.size > 0
        ? `inline:${[...inline].join()}`
        : undefined;
  const [shownDespite, setShownDespite] = useState<string>();
  const compact = foldedBy !== undefined && shownDespite !== foldedBy;
  const waiting = asks.filter((ask) => ask.key !== sheetKey);

  // A notification's Open: show that ask. Its keys still wait out the settle time.
  const focusKey = useAskStackStore((s) => s.focusKey);
  const focusAt = focusKey === undefined ? -1 : asks.findIndex((ask) => ask.key === focusKey);
  if (focusAt >= 0 && cursor.key !== focusKey) setCursor({ key: focusKey, index: focusAt });
  // A jump to an ask here unfolds the stack; the one the sheet opens leaves it folded under it.
  if (focusAt >= 0 && foldedBy !== undefined && focusKey !== sheetKey && compact) {
    setShownDespite(foldedBy);
  }
  useEffect(() => {
    if (focusKey === undefined) return;
    // One the thread's own card answers is shown there, not here.
    if (inline.has(focusKey)) {
      useAskStackStore.getState().focus(undefined);
      return;
    }
    if (cursor.key !== focusKey) return;
    useAskStackStore.getState().focus(undefined);
    // Shown where it can be seen: a stack laid out under another view leaves it to the one on top.
    const root = rootRef.current;
    if (root === null || root.closest("[inert]") !== null) return;
    ringAsk(root, focusKey);
  }, [focusKey, cursor.key, inline]);

  const found = asks.findIndex((ask) => ask.key === cursor.key);
  const index = found >= 0 ? found : Math.min(cursor.index, Math.max(0, asks.length - 1));
  const currentAsk = asks[index];
  if (currentAsk !== undefined && (currentAsk.key !== cursor.key || index !== cursor.index)) {
    setCursor({ key: currentAsk.key, index });
  }

  // The ask this dock has open, for the Board's band to mark: while the stack is the one surface.
  const shownKey = compact ? undefined : currentAsk?.key;
  useEffect(() => {
    if (!focused || workspaceId === undefined) return;
    if (rootRef.current?.closest("[inert]") != null) return;
    useAskStackStore.getState().setCurrent(workspaceId, shownKey);
  }, [focused, workspaceId, shownKey]);
  useEffect(
    () => () => {
      if (workspaceId !== undefined && rootRef.current?.closest("[inert]") == null) {
        useAskStackStore.getState().setCurrent(workspaceId, undefined);
      }
    },
    [workspaceId],
  );

  // When the top ask last changed by itself (answered elsewhere, or a new one), and when this
  // stack last answered: a key in either's wake is a slip, not a decision.
  const stepped = useRef<string | undefined>(undefined);
  const topSince = useRef(0);
  const answeredAt = useRef(0);
  useEffect(() => {
    topSince.current = currentAsk?.key === stepped.current ? 0 : clock();
    stepped.current = undefined;
  }, [currentAsk?.key]);

  const step = (by: number) => {
    const next = stepIndex(index, by, asks.length);
    stepped.current = asks[next]?.key;
    setCursor({ key: asks[next]?.key, index: next });
  };

  // One ring when an ask arrives while you're somewhere else in the thread.
  const arrivals = useArrivals(asks.map((ask) => ask.key));
  const [missed, setMissed] = useState(0);
  useEffect(() => {
    if (arrivals.size === 0) return;
    if (rootRef.current?.contains(document.activeElement)) return;
    setMissed((n) => n + 1);
  }, [arrivals]);

  const takeBack = useAskStackStore((s) => s.undo);
  /** Takes back `key`'s answer, or the newest, and shows that ask again. */
  const undo = (key?: string) => {
    const answer = takeBack(key);
    if (answer === undefined) return false;
    stepped.current = answer.key;
    setCursor({ key: answer.key, index });
    return true;
  };
  const onMemory = (answeredIn: WorkspaceId) => {
    void queryClient.invalidateQueries({ queryKey: ["memory", answeredIn] });
    void queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", answeredIn] });
  };
  const send = (ask: Ask, done: string, action: SendAction) => {
    answeredAt.current = clock();
    holdAnswer(api, ask, done, action, onMemory);
  };
  const choose = (ask: Ask, option: AskOption) => {
    const { action } = option;
    // What must be read in full first is read and answered in the ask sheet, over the dock.
    if (action.kind === "open" || action.kind === "board") {
      if (workspaceId !== undefined) return openAskSheet(workspaceId, ask);
      if (action.kind === "open") open(action.threadId);
      return;
    }
    setPick(ask.key, undefined);
    send(ask, option.done, action);
  };
  const reply = (ask: Ask, text: string) => {
    if (ask.freeForm === undefined) return;
    send(
      ask,
      "Replied",
      ask.worker !== undefined
        ? { kind: "worker", answer: text }
        : ask.memory === undefined
          ? { kind: "answer", answer: replyAnswer(ask.freeForm.question, text) }
          : { kind: "memory", answer: text },
    );
  };

  // Which hints to show, following focus: the composer's modifiers while it has it, the plain keys
  // while nothing that types does, none otherwise.
  const [hints, setHints] = useState<KeyHints>(undefined);
  useEffect(() => {
    if (!focused) return;
    const update = () => {
      // Focus on the stack's own buttons keeps the hints: a click must not move what it pressed. A
      // jump that lands focus on an ask brings the plain keys' hints, which reach it there.
      const active = document.activeElement;
      if (active !== null && rootRef.current?.contains(active)) {
        if (!types(active)) setHints((was) => was ?? "plain");
        return;
      }
      const pane = rootRef.current?.closest(SCOPE);
      setHints(pane == null ? undefined : focusReach(document.activeElement, pane));
    };
    // Focus leaving for nothing lands on the body only after `focusout`.
    const later = () => setTimeout(update);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, [focused]);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    // Laid out under another view, or under Quiet, the stack takes no keys: one listener at a time.
    if (rootRef.current?.closest("[inert]") != null) return;
    const pane = rootRef.current?.closest(SCOPE);
    if (pane == null) return;
    const target = event.target instanceof Element ? event.target : null;
    // A choice just clicked keeps focus, and the stack's keys with it; its reply field types.
    const own = target !== null && rootRef.current?.contains(target) === true;
    const reach = own ? (types(target) ? undefined : "plain") : focusReach(target, pane);
    if (reach === undefined) return;
    const mod = event.metaKey || event.ctrlKey;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
      // In a composer with a draft, ⌘Z is the draft's.
      if (reach === "composer" && composerHolds(pane, composerThreadId)) return;
      if (undo()) take();
      return;
    }
    // Folded, something else answers: its keys are its own.
    if (compact || currentAsk === undefined) return;
    // The pick: plain in the open, with ⌥ in the composer. The send: ⌘⏎ in both.
    let pick: number | undefined;
    let sending = false;
    if (reach === "plain" && !mod && !event.altKey && !event.shiftKey) {
      if (/^[1-9]$/.test(event.key)) pick = Number(event.key) - 1;
      else if (event.key === "Enter" && !own && currentAsk.freeForm !== undefined) {
        take();
        replyRefs.current.get(currentAsk.key)?.focus();
        return;
      } else if (event.key === "ArrowRight" && asks.length > 1) {
        take();
        step(1);
        return;
      }
    } else if (!event.shiftKey && !event.altKey && mod && event.key === "Enter") {
      sending = reach === "plain" || !composerHolds(pane, composerThreadId);
    } else if (reach === "composer" && !event.shiftKey && event.altKey && !mod) {
      if (/^Digit[1-9]$/.test(event.code)) pick = Number(event.code.slice(5)) - 1;
    }
    if (pick === undefined && !sending) return;
    const picked = pick ?? picks[currentAsk.key];
    const option = picked === undefined ? undefined : currentAsk.options[picked];
    // Nothing picked to send: an empty composer's ⌘⏎ stays its own.
    if (option === undefined || picked === undefined) return;
    take();
    const now = clock();
    if (now - answeredAt.current < SETTLE_MS || now - topSince.current < SETTLE_MS) return;
    if (sending) choose(currentAsk, option);
    else setPick(currentAsk.key, picked);
  });
  useEffect(() => {
    if (!focused) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [focused]);

  const last = held.at(-1);
  const shown = compact ? [] : expanded ? asks : currentAsk === undefined ? [] : [currentAsk];
  const visible =
    (compact ? waiting.length > 0 : asks.length > 0) || elsewhere.length > 0 || last !== undefined;
  const keyHints = focused && asks.length > 0 && !compact ? hints : undefined;
  const problemOf = (ask: Ask) =>
    ask.ids.map((id) => problems[id]).find((problem) => problem !== undefined);

  return (
    <div ref={rootRef} className="shrink-0 bg-thread px-3 pt-2" data-testid="ask-stack-dock">
      {visible && (
        <PulseOnce
          trigger={missed}
          when={missed > 0}
          tone="needs"
          className="mx-auto flex w-full max-w-(--thread-max-width) [&>.gram-pulse-once]:rounded-(--composer-radius)"
        >
          <section
            data-testid="ask-stack"
            aria-label="Asks"
            data-count={asks.length}
            data-expanded={expanded || undefined}
            data-compact={compact || undefined}
            className="w-full overflow-clip rounded-(--composer-radius) border border-(--composer-outline) bg-card"
          >
            <header className="flex items-center gap-2 py-1.5 pr-2 pl-3.5 text-xs text-muted-foreground">
              <Hand aria-hidden className="size-3.5 shrink-0" />
              {/* No count of its own: the stepper says how many, and the workspace's badge counts
                  them with everything else that needs you (`needsYouCounts`). */}
              <span className="font-medium text-foreground">Asks</span>
              {compact && waiting.length > 0 && (
                <span data-testid="ask-stack-waiting" className="truncate">
                  {waiting.length} more waiting
                </span>
              )}
              {last !== undefined && (
                <span
                  key={last.key}
                  data-testid="ask-undo-line"
                  className="flex min-w-0 items-center gap-1 text-foreground"
                >
                  <DrawnCheck className="size-3.5 text-success-text" />
                  <span className="truncate">{last.done}</span>
                  <button
                    type="button"
                    data-testid="ask-undo"
                    onClick={() => undo(last.key)}
                    className="ml-0.5 rounded-sm px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Undo
                  </button>
                  {keyHints !== undefined && <Kbd>{formatKeys("mod+z")}</Kbd>}
                </span>
              )}
              <span className="flex-1" />
              {elsewhere.map((w) => (
                <button
                  key={w.workspaceId}
                  type="button"
                  data-testid="ask-elsewhere"
                  onClick={() => {
                    if (w.orchestratorThreadId !== undefined) return open(w.orchestratorThreadId);
                    void api
                      .openOrchestrator({ workspaceId: w.workspaceId })
                      .then((orchestrator) => open(orchestrator.id));
                  }}
                  title={`Open ${w.name}'s orchestrator`}
                  className="truncate rounded-sm px-1 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Also in {w.name}
                </button>
              ))}
              {compact && waiting.length > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="ask-stack-show"
                  aria-label={`Show ${waiting.length} more waiting`}
                  onClick={() => setShownDespite(foldedBy)}
                >
                  Show
                </Button>
              )}
              {!compact && !expanded && asks.length > 1 && (
                <span className="flex items-center">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Previous ask"
                    data-testid="ask-prev"
                    onClick={() => step(-1)}
                  >
                    <ChevronLeft aria-hidden />
                  </Button>
                  <span className="min-w-8 text-center font-mono tabular-nums" aria-live="polite">
                    {index + 1}/{asks.length}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Next ask"
                    data-testid="ask-next"
                    onClick={() => step(1)}
                  >
                    <ChevronRight aria-hidden />
                  </Button>
                  {keyHints === "plain" && <Kbd>→</Kbd>}
                </span>
              )}
              {!compact && asks.length > 1 && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={expanded ? "Show one ask" : "Show all asks"}
                  aria-expanded={expanded}
                  data-testid="ask-expand"
                  onClick={() => setExpanded((was) => !was)}
                >
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "transition-transform duration-(--dur-fast)",
                      expanded && "rotate-180",
                    )}
                  />
                </Button>
              )}
            </header>
            <ul aria-label="Open asks">
              <PresenceList>
                {shown.map((ask) => (
                  <PresenceItem
                    key={ask.key}
                    as="li"
                    glide={expanded}
                    // Clipped, so an answered ask folds under its own edge rather than over the next.
                    className={cn("overflow-clip", expanded && "border-t border-border/60 pt-1.5")}
                  >
                    <AskItem
                      ask={ask}
                      current={ask.key === currentAsk?.key}
                      hints={keyHints}
                      arrived={arrivals.has(ask.key)}
                      problem={problemOf(ask)}
                      picked={picks[ask.key]}
                      onPick={(at) => setPick(ask.key, at)}
                      onChoose={(option) => choose(ask, option)}
                      onReply={(text) => reply(ask, text)}
                      replyRef={(element) => {
                        if (element === null) replyRefs.current.delete(ask.key);
                        else replyRefs.current.set(ask.key, element);
                      }}
                    />
                  </PresenceItem>
                ))}
              </PresenceList>
            </ul>
          </section>
        </PulseOnce>
      )}
    </div>
  );
}

const NO_ASKS: readonly Ask[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
