import type {
  MemoryQuestion,
  OrchestratorLedger,
  Project,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";
import { create } from "zustand";

import { keepSame } from "@/lib/same-data";
import { useServerSettings } from "@/settings-sync/store";
import { useAttentionStore } from "@/sidebar/attention";
import { needsYou as threadNeedsYou, splitForTree } from "@/sidebar/grouping";
import { useThreadsStore, whenServerEventsSettle } from "@/stores/threads";

import { asksOf } from "./ask-model";
import type { WorkspaceAsks } from "./ask-stack";
import { hiddenIds, useAskStackStore } from "./ask-stack-store";
import { asleep, snoozesOf } from "./inbox-set-aside";
import { groupInbox, inboxEntries, threadEntries } from "./inbox-model";
import { soloFailures, standingFailures, type FailureItem } from "./needs-you-model";
import { needsYouGroups, type NeedsYouThread } from "./needs-you-items";
import { workspaceTrees } from "./tree-model";
import type { NeedsYouList } from "./use-needs-you";

// Every workspace's asks and the Needs you list, derived once per window and read here by every
// view that shows them: the sidebar's count, each orchestrator's stack, Quiet, the menu bar, away
// notifications, the Board's chips. Each view used to derive them for itself, ten times over on
// every change to any thread.
//
// They are derived here, outside React, as their store inputs change (the threads, the answers
// held or sent, what is set aside in settings), so a view never reads them a commit behind what it
// reads from those stores; a burst of server events derives them once, at its end. What comes from
// queries (the workspaces, their open questions, ledgers and projects) `NeedsYouSource` hands in.
// A derivation that says what the last one said keeps the last one's lists, so the views that read
// them sit out changes that don't touch them.

/** What `NeedsYouSource` reads from queries and hands in. */
interface QueriedInputs {
  readonly workspaces: readonly WorkspaceState[];
  /** Each workspace's open questions. */
  readonly questions: ReadonlyMap<WorkspaceId, readonly MemoryQuestion[]>;
  /** Each workspace's ledger, which carries its workers' forwarded questions. */
  readonly ledgers: ReadonlyMap<WorkspaceId, OrchestratorLedger>;
  readonly projects: readonly Project[];
}

export interface DerivedAsks {
  /** Every workspace's asks, less what is put away for Later. */
  readonly asks: readonly WorkspaceAsks[];
  /** The same with what is put away for Later left in, which Needs you lists apart. */
  readonly withLater: readonly WorkspaceAsks[];
  readonly needsYou: NeedsYouList;
}

interface DerivedAsksState extends DerivedAsks {
  /** Takes the queried inputs anew and derives again. */
  setQueried(queried: QueriedInputs): void;
}

const NOTHING: NeedsYouList = { groups: [], items: [], later: [] };
const NO_QUERIED: QueriedInputs = {
  workspaces: [],
  questions: new Map(),
  ledgers: new Map(),
  projects: [],
};

/** The asks, with and without Later's, and Needs you, from everything they are read from. */
const deriveAsks = (queried: QueriedInputs, now: number): DerivedAsks & { wakes?: number } => {
  const { byId } = useThreadsStore.getState();
  const { held, sent } = useAskStackStore.getState();
  const inbox = useServerSettings.getState().settings?.inbox;
  const { workspaces, questions, ledgers, projects } = queried;

  const snoozes = snoozesOf(inbox?.snoozed);
  const sleeping = asleep(snoozes, now);
  const away = new Map([...snoozes].filter(([id]) => sleeping.ids.has(id)));
  const cleared = new Set(inbox?.cleared ?? []);
  // Set aside in settings: away from every view.
  const setAside = new Set([...away.keys(), ...cleared]);
  const answered = hiddenIds({ held, sent });

  const ids = new Set<string>(workspaces.map((state) => state.workspace.id));
  const names = new Map(projects.map((project) => [project.id as string, project.name]));
  const projectName = (id: string) => names.get(id);
  const split = splitForTree(Object.values(byId), ids);
  const trees = workspaceTrees(workspaces, split.tree);
  const sources = trees.map((tree) => {
    const orchestratorThreadId =
      tree.orchestrator?.thread.id ?? tree.workspace.orchestratorThreadId;
    return {
      tree,
      orchestratorThreadId,
      source: {
        groups: groupInbox(inboxEntries(tree, projectName)),
        // An answer to an open question is a message to the orchestrator, so it needs one.
        questions:
          orchestratorThreadId === undefined ? [] : (questions.get(tree.workspace.id) ?? []),
        workerQuestions: ledgers.get(tree.workspace.id)?.questions ?? [],
        workspaceId: tree.workspace.id,
        orchestratorId: orchestratorThreadId,
      },
    };
  });
  const asksLess = (aside: ReadonlySet<string>): WorkspaceAsks[] => {
    const hidden = new Set([...answered, ...aside]);
    return sources.map(({ tree, orchestratorThreadId, source }) => ({
      workspaceId: tree.workspace.id,
      name: tree.workspace.name,
      orchestratorThreadId,
      asks: asksOf({ ...source, hidden }),
    }));
  };
  const asks = asksLess(setAside);
  const withLater = asksLess(cleared);

  // Needs you: the asks with Later's, every standing failure and every thread's waits, less what
  // is answered or dismissed, with what is put away for Later apart.
  const hidden = new Set([...answered, ...cleared]);
  const failures = new Map<WorkspaceId, readonly FailureItem[]>(
    withLater.map((w) => [
      w.workspaceId,
      standingFailures(ledgers.get(w.workspaceId), byId, hidden),
    ]),
  );
  const threads = Object.values(byId).filter(
    (summary): summary is NonNullable<typeof summary> => summary !== undefined,
  ) as readonly NeedsYouThread[];
  // The threads outside any workspace bring their requests and errors while they need the user, as
  // the window title and the dock badge count them.
  const solo = split.listed.filter((summary) => threadNeedsYou(summary));
  const source = {
    workspaces: withLater,
    failures,
    threads,
    solo: {
      asks: asksOf({ groups: groupInbox(threadEntries(solo, projectName)), hidden }),
      failures: soloFailures(solo, hidden, projectName),
    },
  };
  const groups = needsYouGroups({ ...source, away: new Set([...away.keys(), ...hidden]) });
  const later = needsYouGroups({ ...source, away: hidden })
    .flatMap((group) => group.items)
    .flatMap((item) => {
      const wakes = item.ids.map((id) => away.get(id)).find((at) => at !== undefined);
      return wakes === undefined ? [] : [{ item, wakes }];
    })
    .toSorted((a, b) => a.wakes - b.wakes);
  return {
    asks,
    withLater,
    needsYou: { groups, items: groups.flatMap((group) => group.items), later },
    ...(sleeping.wakes === undefined ? {} : { wakes: sleeping.wakes }),
  };
};

let queried = NO_QUERIED;
/** Whether a `NeedsYouSource` has handed anything in; until one has, nothing reads the lists. */
let sourced = false;
let wake: ReturnType<typeof setTimeout> | undefined;

export const useDerivedAsks = create<DerivedAsksState>()((set, get) => {
  const derive = () => {
    const next = deriveAsks(queried, Date.now());
    // A snoozed item comes back on its own when it wakes; at least a second on, so a clock a
    // little behind the wake doesn't spin.
    clearTimeout(wake);
    wake =
      next.wakes === undefined
        ? undefined
        : setTimeout(derive, Math.max(1_000, next.wakes - Date.now()));
    const current = get();
    const asks = keepSame(current.asks, next.asks);
    const withLater = keepSame(current.withLater, next.withLater);
    const needsYou = keepSame(current.needsYou, next.needsYou);
    if (asks === current.asks && withLater === current.withLater && needsYou === current.needsYou) {
      return;
    }
    set({ asks, withLater, needsYou });
  };
  // Run from the input stores' listeners: a derivation that fails is logged, never thrown at
  // whoever changed the store, and never keeps that store's later listeners from hearing of it.
  const safely = () => {
    try {
      derive();
    } catch (error) {
      console.error("deriving asks failed", error);
    }
  };
  const changed = () => {
    if (sourced) whenServerEventsSettle(safely);
  };
  useThreadsStore.subscribe((s, previous) => {
    if (s.byId !== previous.byId) changed();
  });
  useAskStackStore.subscribe((s, previous) => {
    if (s.held !== previous.held || s.sent !== previous.sent) changed();
  });
  useServerSettings.subscribe((s, previous) => {
    if (s.settings?.inbox !== previous.settings?.inbox) changed();
  });
  // A parked thread outside any workspace needs the user while its PR has attention unseen.
  useAttentionStore.subscribe((s, previous) => {
    if (s.acknowledged !== previous.acknowledged || s.loaded !== previous.loaded) changed();
  });
  return {
    asks: [],
    withLater: [],
    needsYou: NOTHING,
    setQueried(next) {
      queried = next;
      sourced = true;
      derive();
    },
  };
});

/** Back to nothing handed in and nothing derived, as a window starts; for tests. */
export const resetDerivedAsks = () => {
  queried = NO_QUERIED;
  sourced = false;
  clearTimeout(wake);
  wake = undefined;
  useDerivedAsks.setState({ asks: [], withLater: [], needsYou: NOTHING });
};
