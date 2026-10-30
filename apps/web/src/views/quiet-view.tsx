import { Menu } from "@base-ui/react/menu";
import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ellipsis, ListChecks, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatKeys } from "@/keyboard/registry";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { DrawnCheck, Swap } from "@/motion";
import { clock, plainKeysReach, SETTLE_MS } from "@/orchestration/ask-keys";
import { AskChoices, Kbd, MoreText, plainHint } from "@/orchestration/ask-choices";
import {
  askKeysByThread,
  choiceLayout,
  replyAnswer,
  type Ask,
  type AskOption,
} from "@/orchestration/ask-model";
import {
  AskDetails,
  askTotals,
  ReplyField,
  useOpenThread,
  useWorkspaceAsks,
  type WorkspaceAsks,
} from "@/orchestration/ask-stack";
import { holdAnswer, type SendAction } from "@/orchestration/ask-answer";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { useDerivedAsks } from "@/orchestration/needs-you-store";
import { allWorkspacesPaused, setAllWorkspacesPaused } from "@/orchestration/pause-workspace";
import { useOrchestratorLedgers, useWorkspaces } from "@/orchestration/use-orchestration";
import { workersByTab, type WorkerRow } from "@/orchestration/workers-model";
import { useServerSettings } from "@/settings-sync/store";
import { UsageMeter } from "@/shell/usage-meter";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";

import { useOpenBoard } from "@/orchestration/open-board";
import type { ViewProps } from "./board-view";
import {
  dotTone,
  quietDeck,
  quietSummary,
  sendLater,
  shouldEnterQuiet,
  type DeckCard,
  type DeckSource,
  type DotTone,
  type StripWorkspace,
} from "./quiet-model";
import { useViewStore } from "./view-store";

const ICON = { approval: ShieldQuestion, question: MessageCircleQuestion, plan: ListChecks };

const DOT: Readonly<Record<DotTone, string>> = {
  working: "bg-status-working",
  // Busy on CI or a review rather than a turn: the working colour, hollow.
  waiting: "border border-status-working bg-transparent",
  needs: "bg-status-needs",
  error: "bg-destructive",
  idle: "bg-status-idle/60",
};

const MENU_POPUP =
  "z-50 min-w-40 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

const pad = (n: number) => String(n).padStart(2, "0");

/** Leaves Quiet, then goes to the thread, so what opens is in view. */
function useLeaveTo() {
  const open = useOpenThread();
  return (threadId: ThreadId) => {
    useViewStore.getState().setQuiet(false);
    open(threadId);
  };
}

/**
 * The strip's workspaces: each one's Now workers, its asks, and what merged today. The menu bar's
 * workspace lines count from it too.
 */
export function useQuietStrip(all: readonly WorkspaceAsks[]): StripWorkspace[] {
  const ids = useMemo(() => all.map((w) => w.workspaceId), [all]);
  const ledgers = useOrchestratorLedgers(ids);
  // Minute resolution is enough for "today".
  const now = useNow(true, undefined, 60_000);
  // Only the strip: a thread's change that leaves it reading the same leaves its readers still.
  return useThreadsStore(
    useSame(({ byId, statusDetail }) =>
      all.map((w) => {
        const asking = new Set(askKeysByThread(w.asks).keys());
        const tabs = workersByTab(ledgers.get(w.workspaceId), {
          byId,
          statusDetail,
          now,
          asking,
        });
        return {
          workspaceId: w.workspaceId,
          name: w.name,
          orchestratorThreadId: w.orchestratorThreadId,
          workers: tabs.now.flatMap((feature) => feature.rows),
          asks: w.asks.length,
          mergedToday: tabs.doneToday
            .flatMap((feature) => feature.rows)
            .filter((row) => row.glyph === "merged").length,
        };
      }),
    ),
  );
}

/** The solo threads' asks as one more source of cards, after every workspace's. */
const soloSource = (asks: readonly Ask[]): DeckSource => ({
  workspaceId: undefined,
  name: "Solo threads",
  orchestratorThreadId: undefined,
  asks,
});

/**
 * Quiet: an empty field, one strip at the bottom with a dot per worker, and, when something needs
 * you, one card at a time. ⏎ takes the first answer, 1 and 2 pick, → sends a card to the back and
 * O opens its thread; never while typing in its reply. Answers hold through the ask stack's store,
 * so what is answered here is gone from every view, and ⌘Z or Undo brings it back while it waits.
 */
export function QuietView({ workspaceId }: ViewProps) {
  const all = useWorkspaceAsks();
  const solo = useDerivedAsks((s) => s.soloAsks);
  const strip = useQuietStrip(all);
  const [later, setLater] = useState<readonly string[]>([]);
  const deck = useMemo(
    () => quietDeck([...all, soloSource(solo)], workspaceId, later),
    [all, solo, workspaceId, later],
  );
  const [peek, setPeek] = useState<WorkspaceId>();
  const api = useApi();
  const queryClient = useQueryClient();
  const openBoard = useOpenBoard();
  const leaveTo = useLeaveTo();
  const held = useAskStackStore((s) => s.held);
  const problems = useAskStackStore((s) => s.problems);
  const takeBack = useAskStackStore((s) => s.undo);
  const rootRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLInputElement | null>(null);

  const card = deck[0];
  // When the top card last changed by itself, and when Quiet last answered: a key in either's wake
  // is a slip, not a decision.
  const stepped = useRef<string | undefined>(undefined);
  const topSince = useRef(0);
  const answeredAt = useRef(0);
  useEffect(() => {
    topSince.current = card?.ask.key === stepped.current ? 0 : clock();
    stepped.current = undefined;
  }, [card?.ask.key]);

  const sendBack = (key: string) => {
    const live = new Set(deck.map((each) => each.ask.key));
    const next = sendLater(later, key, live);
    stepped.current = deck.find((each) => !next.includes(each.ask.key))?.ask.key ?? next[0];
    setLater(next);
  };
  const onMemory = (answered: WorkspaceId) =>
    void queryClient.invalidateQueries({ queryKey: ["memory", answered] });
  const send = (ask: Ask, done: string, action: SendAction) => {
    answeredAt.current = clock();
    holdAnswer(api, ask, done, action, onMemory);
  };
  const choose = (each: DeckCard, option: AskOption) => {
    const { action } = option;
    if (action.kind === "open") return leaveTo(action.threadId);
    if (action.kind === "board") {
      useViewStore.getState().setQuiet(false);
      openBoard(action.workspaceId, { waiting: true });
      return;
    }
    send(each.ask, option.done, action);
  };
  const reply = (ask: Ask, text: string) => {
    if (ask.freeForm === undefined) return;
    send(
      ask,
      "Replied",
      ask.memory === undefined
        ? { kind: "answer", answer: replyAnswer(ask.freeForm.question, text) }
        : { kind: "memory", answer: text },
    );
  };
  const undo = (key?: string) => {
    const answer = takeBack(key);
    if (answer === undefined) return false;
    stepped.current = answer.key;
    return true;
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const root = rootRef.current;
    if (root === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!plainKeysReach(target, root)) return;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
      if (undo()) take();
      return;
    }
    if (mod || event.altKey || event.shiftKey || event.repeat || card === undefined) return;
    const key = event.key.toLowerCase();
    const pick =
      event.key === "Enter" ? 0 : /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined;
    if (pick === undefined && key !== "o" && event.key !== "ArrowRight") return;
    const now = clock();
    if (now - answeredAt.current < SETTLE_MS || now - topSince.current < SETTLE_MS) {
      take();
      return;
    }
    if (event.key === "ArrowRight") {
      take();
      if (deck.length > 1) sendBack(card.ask.key);
      return;
    }
    if (key === "o") {
      if (card.threadId === undefined) return;
      take();
      leaveTo(card.threadId);
      return;
    }
    if (pick === undefined) return;
    if (pick === 0 && card.ask.freeForm !== undefined) {
      take();
      replyRef.current?.focus();
      return;
    }
    const option = card.ask.options[pick];
    if (option === undefined) return;
    take();
    choose(card, option);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  const last = held.at(-1);
  const peeked = strip.find((w) => w.workspaceId === peek);
  const problem =
    card === undefined
      ? undefined
      : card.ask.ids.map((id) => problems[id]).find((each) => each !== undefined);

  return (
    <div
      ref={rootRef}
      data-testid="quiet-view"
      className="flex min-h-0 flex-1 flex-col bg-thread text-foreground"
    >
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4">
        <Swap swapKey={card?.ask.key ?? "empty"} as="div" className="w-full max-w-xl">
          {card === undefined ? (
            <div data-testid="quiet-empty" className="grid gap-1.5 text-center">
              <p className="text-xl">Nothing needs you.</p>
              <p data-testid="quiet-summary" className="text-[15px] text-muted-foreground">
                {quietSummary(strip)}
              </p>
            </div>
          ) : (
            <QuietCard
              card={card}
              total={deck.length}
              problem={problem}
              onChoose={(option) => choose(card, option)}
              onReply={(text) => reply(card.ask, text)}
              onLater={deck.length > 1 ? () => sendBack(card.ask.key) : undefined}
              onOpen={card.threadId === undefined ? undefined : () => leaveTo(card.threadId!)}
              replyRef={(element) => {
                replyRef.current = element;
              }}
            />
          )}
        </Swap>
        {last !== undefined && (
          <p
            key={last.key}
            data-testid="quiet-undo-line"
            className="mt-4 flex items-center gap-1 text-[13px]"
          >
            <DrawnCheck className="size-3.5 text-success-text" />
            {last.done}
            <button
              type="button"
              data-testid="quiet-undo"
              onClick={() => undo(last.key)}
              className="ml-0.5 rounded-sm px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Undo
            </button>
            <Kbd>{formatKeys("mod+z")}</Kbd>
          </p>
        )}
      </main>
      {peeked !== undefined && (
        <Peek workspace={peeked} onClose={() => setPeek(undefined)} onOpen={leaveTo} />
      )}
      <Strip
        strip={strip}
        asks={deck.length}
        peek={peek}
        onPeek={(id) => setPeek(id === peek ? undefined : id)}
      />
    </div>
  );
}

function QuietCard({
  card,
  total,
  problem,
  onChoose,
  onReply,
  onLater,
  onOpen,
  replyRef,
}: {
  card: DeckCard;
  total: number;
  problem: string | undefined;
  onChoose: (option: AskOption) => void;
  onReply: (text: string) => void;
  onLater: (() => void) | undefined;
  onOpen: (() => void) | undefined;
  replyRef: (element: HTMLInputElement | null) => void;
}) {
  const { ask } = card;
  const Icon = ICON[ask.icon];
  const listed = choiceLayout(ask.options) === "list";
  return (
    <section
      data-testid="quiet-card"
      data-key={ask.key}
      aria-label="Needs you"
      className="grid gap-3 rounded-lg border border-border bg-card p-5 shadow-sm"
    >
      <header className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Icon aria-hidden className="size-4 shrink-0 text-status-needs" />
        <span className="truncate">{card.workspace}</span>
        <span className="flex-1" />
        <span data-testid="quiet-position" className="tabular-nums">
          1 of {total}
        </span>
      </header>
      <div className="grid gap-1.5">
        <p className="text-lg break-words" data-testid="quiet-title">
          {ask.lead}
          {ask.count > 1 && <span className="text-muted-foreground"> × {ask.count}</span>}
        </p>
        {ask.command !== undefined && (
          <pre
            data-testid="quiet-command"
            className="overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-xs break-all whitespace-pre-wrap"
          >
            {ask.command}
          </pre>
        )}
        {ask.extras.length > 0 && (
          <p className="font-mono text-[11px] break-all text-muted-foreground">
            {ask.extras.map((field, at) => (
              <span key={field.label}>
                {at > 0 && " · "}
                {field.label}: <span className="text-foreground">{field.value}</span>
              </span>
            ))}
          </p>
        )}
        <p className="text-[13px] text-muted-foreground">{ask.context}</p>
        {ask.description !== undefined && ask.description.trim() !== "" && (
          <MoreText
            text={ask.description}
            lines={3}
            testId="quiet-description"
            className="text-[13px] text-muted-foreground"
          />
        )}
        <AskDetails ask={ask} />
        {ask.freeForm !== undefined && (
          <ReplyField ask={ask} current onSend={onReply} inputRef={replyRef} />
        )}
        {problem !== undefined && (
          <p role="alert" data-testid="quiet-problem" className="text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
      {listed && (
        <AskChoices
          options={ask.options}
          hintOf={plainHint}
          onChoose={onChoose}
          testId="quiet-option"
          size="default"
        />
      )}
      <footer className="flex flex-wrap items-center gap-1">
        {!listed && (
          <AskChoices
            options={ask.options}
            hintOf={plainHint}
            onChoose={onChoose}
            testId="quiet-option"
            size="default"
            // Its buttons sit in this row, beside Later and Open thread.
            className="contents"
          />
        )}
        <span className="flex-1" />
        {onLater !== undefined && (
          <Button variant="ghost" size="sm" data-testid="quiet-later" onClick={onLater}>
            Later
            <Kbd>→</Kbd>
          </Button>
        )}
        {onOpen !== undefined && (
          <Button variant="ghost" size="sm" data-testid="quiet-open" onClick={onOpen}>
            Open thread
            <Kbd>O</Kbd>
          </Button>
        )}
      </footer>
    </section>
  );
}

/** One workspace's workers, opened from its place in the strip. */
function Peek({
  workspace,
  onClose,
  onOpen,
}: {
  workspace: StripWorkspace;
  onClose: () => void;
  onOpen: (threadId: ThreadId) => void;
}) {
  const api = useApi();
  const talk = () => {
    if (workspace.orchestratorThreadId !== undefined) return onOpen(workspace.orchestratorThreadId);
    void api
      .openOrchestrator({ workspaceId: workspace.workspaceId })
      .then((thread) => onOpen(thread.id));
  };
  return (
    <section
      data-testid="quiet-peek"
      aria-label={workspace.name}
      className="mx-auto mb-2 grid w-[min(36rem,calc(100%-2rem))] gap-1 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <header className="flex items-center gap-2">
        <h2 className="font-medium">{workspace.name}</h2>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </header>
      {workspace.workers.length === 0 ? (
        <p className="text-muted-foreground">No workers running.</p>
      ) : (
        <ul className="grid gap-0.5">
          {workspace.workers.map((row) => (
            <PeekRow key={row.threadId} row={row} onOpen={() => onOpen(row.threadId)} />
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" className="mt-1 justify-self-start" onClick={talk}>
        Talk to the orchestrator
      </Button>
    </section>
  );
}

function PeekRow({ row, onOpen }: { row: WorkerRow; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="quiet-peek-worker"
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-(--radius-sm) px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[dotTone(row)])} />
        <span className="min-w-0 flex-1 truncate">{row.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{row.now}</span>
      </button>
    </li>
  );
}

/** The bottom strip: a dot per worker by workspace, the asks, the time, and the one menu. */
function Strip({
  strip,
  asks,
  peek,
  onPeek,
}: {
  strip: readonly StripWorkspace[];
  /** Every card in the deck, the solo threads' included. */
  asks: number;
  peek: WorkspaceId | undefined;
  onPeek: (workspaceId: WorkspaceId) => void;
}) {
  const now = useNow(true, undefined, 30_000);
  const time = new Date(now);
  return (
    <footer
      data-testid="quiet-strip"
      className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 text-[13px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {strip.map((w) => (
          <button
            key={w.workspaceId}
            type="button"
            data-testid="quiet-strip-workspace"
            data-workspace={w.workspaceId}
            aria-pressed={peek === w.workspaceId}
            aria-label={`${w.name}: ${w.workers.length} workers${w.asks > 0 ? `, ${w.asks} asks` : ""}`}
            onClick={() => onPeek(w.workspaceId)}
            className="flex shrink-0 items-center gap-1.5 rounded-(--radius-sm) px-2 py-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            {w.name}
            <span className="flex items-center gap-0.5">
              {w.workers.map((row) => (
                <span
                  key={row.threadId}
                  data-testid="quiet-dot"
                  data-tone={dotTone(row)}
                  className={cn("size-1.5 rounded-full", DOT[dotTone(row)])}
                />
              ))}
            </span>
          </button>
        ))}
      </div>
      {asks > 0 && (
        <span data-testid="quiet-asks" className="text-status-needs tabular-nums">
          {asks} {asks === 1 ? "ask" : "asks"}
        </span>
      )}
      <UsageMeter />
      <span className="text-muted-foreground tabular-nums">
        {pad(time.getHours())}:{pad(time.getMinutes())}
      </span>
      <QuietMenu />
    </footer>
  );
}

/** Quiet's one menu: Pause all, New task, Settings. */
function QuietMenu() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const allPaused = allWorkspacesPaused(workspaces);
  const leave = (to: string) => {
    useViewStore.getState().setQuiet(false);
    void navigate({ to });
  };
  const pauseAll = () => setAllWorkspacesPaused(api, queryClient, workspaces, !allPaused);
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="quiet-menu"
        render={<Button size="icon-xs" variant="ghost" aria-label="More" title="More" />}
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="isolate z-50">
          <Menu.Popup data-surface="overlay" data-testid="quiet-menu-popup" className={MENU_POPUP}>
            {workspaces.length > 0 && (
              <Menu.Item className={MENU_ITEM} onClick={() => void pauseAll()}>
                {allPaused ? "Resume all" : "Pause all"}
              </Menu.Item>
            )}
            <Menu.Item className={MENU_ITEM} onClick={() => leave("/new-task")}>
              New task
            </Menu.Item>
            <Menu.Item className={MENU_ITEM} onClick={() => leave("/settings")}>
              Settings
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** What counts as the user being at the window. */
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;

/**
 * Called once per window by the shell, in and out of Quiet. With Quiet when idle on, the window
 * drops into Quiet by itself after `QUIET_IDLE_MS` without a key, click or move while nothing is
 * asked. Leaving is the user's: Esc, Leave quiet, or any view's key.
 */
export function useQuietMode(): void {
  const enabled = useServerSettings((s) => s.settings?.layout?.quietWhenIdle === true);
  // Not before the settings have loaded, which say whether Quiet when idle is on.
  const available = useServerSettings((s) => s.settings !== undefined);
  const asks = askTotals(useWorkspaceAsks()).count;
  // Set when the watch starts, below.
  const lastActive = useRef(0);
  const check = useEffectEvent(() => {
    const { quiet, setQuiet } = useViewStore.getState();
    if (
      shouldEnterQuiet({
        enabled,
        available,
        quiet,
        asks,
        idleFor: Date.now() - lastActive.current,
      })
    ) {
      setQuiet(true);
    }
  });
  useEffect(() => {
    if (!enabled || !available) return;
    lastActive.current = Date.now();
    const touched = () => {
      lastActive.current = Date.now();
    };
    for (const type of ACTIVITY) window.addEventListener(type, touched, true);
    const timer = setInterval(() => check(), 15_000);
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, touched, true);
      clearInterval(timer);
    };
  }, [enabled, available]);
  // An ask arriving restarts the wait: the window shouldn't go quiet right after one is answered.
  useEffect(() => {
    if (asks > 0) lastActive.current = Date.now();
  }, [asks]);
}
