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
  Inbox,
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
  NumberTicker,
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

import { clock, inOverlay, plainKeysReach, SETTLE_MS } from "./ask-keys";
import { AskChoices, Kbd, MoreText, plainHint } from "./ask-choices";
import { holdAnswer, type SendAction } from "./ask-answer";
import {
  replyAnswer,
  replyChips,
  stepIndex,
  type Ask,
  type AskMember,
  choiceLayout,
  type AskOption,
} from "./ask-model";
import { useAskStackStore } from "./ask-stack-store";
import { useDerivedAsks } from "./needs-you-store";
import { useOpenBoard } from "./open-board";

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
}: {
  ask: Ask;
  current: boolean;
  onSend: (text: string) => void;
  inputRef: (element: HTMLInputElement | null) => void;
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
        <Button size="sm" type="submit" data-testid="ask-reply-send" disabled={text.trim() === ""}>
          Send
        </Button>
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
          className="size-3 shrink-0 transition-transform duration-(--dur-fast) group-data-[panel-open]:rotate-90"
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
  if (hints === "plain") return plainHint(index);
  return index === 0 ? formatKeys("mod+enter") : formatKeys(`alt+${index + 1}`);
};

function AskItem({
  ask,
  current,
  hints,
  arrived,
  problem,
  onChoose,
  onReply,
  replyRef,
}: {
  ask: Ask;
  current: boolean;
  hints: KeyHints;
  arrived: boolean;
  problem: string | undefined;
  onChoose: (option: AskOption) => void;
  onReply: (text: string) => void;
  replyRef: (element: HTMLInputElement | null) => void;
}) {
  const level = useMotionLevel();
  const spring = usePresetTransition("gentle");
  const Icon = ICON[ask.icon];
  const rise = arrived && level === "full";
  return (
    <m.div
      initial={rise ? { y: 14 } : false}
      animate={{ y: 0 }}
      transition={spring}
      data-testid="ask-item"
      data-current={current || undefined}
      // Focusable from a jump (the overview's "asks you"), where the stack's plain keys answer it.
      tabIndex={-1}
      // In a narrow chat (a worker kept beside it), the answers wrap under the question rather than
      // squeeze it to a letter a line.
      className="flex flex-wrap items-start gap-2.5 px-3.5 pt-1 pb-2.5 outline-none"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-status-needs" />
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
          <ReplyField ask={ask} current={current} onSend={onReply} inputRef={replyRef} />
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
          hintOf={(index) => (current ? hintOf(hints, index) : undefined)}
          onChoose={onChoose}
          testId="ask-option"
          rest="ghost"
          // A row sits to the right of the question while it fits; a list goes under it, as wide.
          className={
            choiceLayout(ask.options) === "row" ? "ml-auto justify-end" : "basis-full pl-6.5"
          }
        />
      )}
    </m.div>
  );
}

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
 * the rest a count. Equal approvals are one ask, and the orchestrator's own requests and open
 * questions are asks too. With focus on nothing that types, ⏎ takes the first option, 1 and 2
 * pick and → steps; in the composer ⌘⏎, ⌥1 and ⌥2 do, so typing is never taken. An answer waits
 * `UNDO_MS` before it goes out.
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
  const openBoard = useOpenBoard();
  const open = useOpenThread();
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRefs = useRef(new Map<string, HTMLInputElement>());
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState<{ key: string | undefined; index: number }>({
    key: undefined,
    index: 0,
  });

  const here = all.find((w) => w.workspaceId === workspaceId);
  const asks = here?.asks ?? [];
  const elsewhere = all.filter((w) => w.workspaceId !== workspaceId && w.asks.length > 0);

  // A notification's Open: show that ask. Its keys still wait out the settle time.
  const focusKey = useAskStackStore((s) => s.focusKey);
  const focusAt = focusKey === undefined ? -1 : asks.findIndex((ask) => ask.key === focusKey);
  if (focusAt >= 0 && cursor.key !== focusKey) setCursor({ key: focusKey, index: focusAt });
  useEffect(() => {
    if (focusKey !== undefined && cursor.key === focusKey)
      useAskStackStore.getState().focus(undefined);
  }, [focusKey, cursor.key]);

  const found = asks.findIndex((ask) => ask.key === cursor.key);
  const index = found >= 0 ? found : Math.min(cursor.index, Math.max(0, asks.length - 1));
  const currentAsk = asks[index];
  if (currentAsk !== undefined && (currentAsk.key !== cursor.key || index !== cursor.index)) {
    setCursor({ key: currentAsk.key, index });
  }

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
    if (action.kind === "open") return open(action.threadId);
    if (action.kind === "board") {
      openBoard(action.workspaceId, { waiting: true });
      return;
    }
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
      // Focus on the stack's own buttons keeps the hints: a click must not move what it pressed.
      if (rootRef.current?.contains(document.activeElement)) return;
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
    const reach = focusReach(event.target instanceof Element ? event.target : null, pane);
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
    if (currentAsk === undefined) return;
    // The pick: plain in the open, with a modifier in the composer.
    let pick: number | undefined;
    if (reach === "plain" && !mod && !event.altKey && !event.shiftKey) {
      if (event.key === "Enter") pick = 0;
      else if (/^[1-9]$/.test(event.key)) pick = Number(event.key) - 1;
      else if (event.key === "ArrowRight" && asks.length > 1) {
        take();
        step(1);
        return;
      }
    } else if (reach === "composer" && !event.shiftKey) {
      if (mod && !event.altKey && event.key === "Enter" && !composerHolds(pane, composerThreadId)) {
        pick = 0;
      } else if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code)) {
        pick = Number(event.code.slice(5)) - 1;
      }
    }
    if (pick === undefined) return;
    // A request card the orchestrator's thread still shows answers Enter itself: one key, one place.
    if (pick === 0 && reach === "plain" && pane.querySelector('[data-testid="approval-card"]')) {
      return;
    }
    const now = clock();
    if (now - answeredAt.current < SETTLE_MS || now - topSince.current < SETTLE_MS) {
      take();
      return;
    }
    if (pick === 0 && currentAsk.freeForm !== undefined) {
      take();
      replyRefs.current.get(currentAsk.key)?.focus();
      return;
    }
    const option = currentAsk.options[pick];
    if (option === undefined) return;
    take();
    choose(currentAsk, option);
  });
  useEffect(() => {
    if (!focused) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [focused]);

  const last = held.at(-1);
  const shown = expanded ? asks : currentAsk === undefined ? [] : [currentAsk];
  const visible = asks.length > 0 || elsewhere.length > 0 || last !== undefined;
  const keyHints = focused && asks.length > 0 ? hints : undefined;
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
            data-expanded={expanded || undefined}
            className="w-full overflow-clip rounded-(--composer-radius) border border-(--composer-outline) bg-card"
          >
            <header className="flex items-center gap-2 py-1.5 pr-2 pl-3.5 text-xs text-muted-foreground">
              <Inbox aria-hidden className="size-3.5 shrink-0" />
              <span>
                <NumberTicker
                  value={asks.length}
                  className="font-medium text-foreground tabular-nums"
                />{" "}
                <span data-testid="ask-stack-count" className="sr-only">
                  {asks.length}
                </span>
                {asks.length === 1 ? "ask" : "asks"}
              </span>
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
                  className="truncate rounded-sm px-1 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {w.asks.length} in {w.name}
                </button>
              ))}
              {!expanded && asks.length > 1 && (
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
              {asks.length > 1 && (
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
