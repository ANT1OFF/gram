import type {
  MemoryQuestion,
  OrchestratorLedger,
  Project,
  ThreadId,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";
import { useMemo } from "react";
import { create } from "zustand";

import { keepSame } from "@/lib/same-data";
import { useServerSettings } from "@/settings-sync/store";
import { useAttentionStore } from "@/sidebar/attention";
import { needsYou as threadNeedsYou, splitForTree } from "@/sidebar/grouping";
import { useThreadsStore, whenServerEventsSettle } from "@/stores/threads";

import { askKeysByThread, asksOf, type Ask } from "./ask-model";
import type { WorkspaceAsks } from "./ask-stack";
import { hiddenIds, useAskStackStore } from "./ask-stack-store";
import { asleep, snoozesOf } from "./inbox-set-aside";
import { groupInbox, inboxEntries, threadEntries } from "./inbox-model";
import {
  soloFailures,
  standingFailures,
  threadNeedsItems,
  type FailureItem,
} from "./needs-you-model";
import {
  needsYouCounts,
  needsYouGroups,
  needsYouSections,
  type NeedsYouThread,
} from "./needs-you-items";
import { workspaceTrees } from "./tree-model";
import type { NeedsYouList } from "./use-needs-you";

interface QueriedInputs {
  readonly workspaces: readonly WorkspaceState[];
  readonly questions: ReadonlyMap<WorkspaceId, readonly MemoryQuestion[]>;
  readonly ledgers: ReadonlyMap<WorkspaceId, OrchestratorLedger>;
  readonly projects: readonly Project[];
}

export interface DerivedAsks {
  /** Every workspace's asks, less what is put away for Later. */
  readonly asks: readonly WorkspaceAsks[];
  /** The same with what is put away for Later left in, which Needs you lists apart. */
  readonly withLater: readonly WorkspaceAsks[];
  /** The asks of threads outside any workspace, less what is put away for Later. */
  readonly soloAsks: readonly Ask[];
  readonly needsYou: NeedsYouList;
  /**
   * The workers whose asks were all answered from here (held for Undo, being sent, or sent a
   * moment ago) and that have none left: what the server still says they wait on is already
   * answered, so their rows, chips and cards say so as the stack and the count do.
   */
  readonly answered: readonly ThreadId[];
}

interface DerivedAsksState extends DerivedAsks {
  setQueried(queried: QueriedInputs): void;
}

const NOTHING: NeedsYouList = { groups: [], sections: [], items: [], later: [] };
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const NO_THREADS: readonly ThreadId[] = [];
const NO_QUERIED: QueriedInputs = {
  workspaces: [],
  questions: new Map(),
  ledgers: new Map(),
  projects: [],
};

const deriveAsks = (queried: QueriedInputs, now: number): DerivedAsks & { wakes?: number } => {
  const { byId } = useThreadsStore.getState();
  const { held, sent } = useAskStackStore.getState();
  const inbox = useServerSettings.getState().settings?.inbox;
  const { workspaces, questions, ledgers, projects } = queried;

  const snoozes = snoozesOf(inbox?.snoozed);
  const sleeping = asleep(snoozes, now);
  const away = new Map([...snoozes].filter(([id]) => sleeping.ids.has(id)));
  const cleared = new Set(inbox?.cleared ?? []);
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
  const answeredWorkers = (() => {
    if (answered.size === 0) return NO_THREADS;
    const left = new Set(asks.flatMap((w) => [...askKeysByThread(w.asks).keys()]));
    const before = sources.flatMap(({ source }) => asksOf({ ...source, hidden: setAside }));
    return [...askKeysByThread(before).keys()].filter((id) => !left.has(id)).toSorted();
  })();

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
  const solo = split.listed.filter((summary) => threadNeedsYou(summary));
  const soloErrors = soloFailures(solo, hidden, projectName);
  const covered = new Set(
    withLater
      .flatMap((w) => standingFailures(ledgers.get(w.workspaceId), byId, NOTHING_HIDDEN))
      .map((item) => item.failure.threadId),
  );
  const soloOthers: FailureItem[] = [];
  const summaries = Object.values(byId).filter((summary) => summary !== undefined);
  for (const item of threadNeedsItems(summaries, covered, hidden, projectName)) {
    const into = item.workspaceId === undefined ? undefined : failures.get(item.workspaceId);
    if (into === undefined) soloOthers.push({ ...item, workspaceId: undefined });
    else failures.set(item.workspaceId!, [...into, item]);
  }
  const soloGroups = groupInbox(threadEntries(solo, projectName));
  const source = {
    workspaces: withLater,
    failures,
    threads,
    solo: {
      asks: asksOf({ groups: soloGroups, hidden }),
      failures: [...soloErrors, ...soloOthers],
    },
  };
  const groups = needsYouGroups({ ...source, away: new Set([...away.keys(), ...hidden]) });
  const sections = needsYouSections(groups);
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
    soloAsks: asksOf({ groups: soloGroups, hidden: new Set([...answered, ...setAside]) }),
    needsYou: { groups, sections, items: sections.flatMap((section) => section.items), later },
    answered: answeredWorkers,
    ...(sleeping.wakes === undefined ? {} : { wakes: sleeping.wakes }),
  };
};

let queried = NO_QUERIED;
let sourced = false;
let wake: ReturnType<typeof setTimeout> | undefined;

export const useDerivedAsks = create<DerivedAsksState>()((set, get) => {
  const derive = () => {
    const next = deriveAsks(queried, Date.now());
    clearTimeout(wake);
    wake =
      next.wakes === undefined
        ? undefined
        : setTimeout(derive, Math.max(1_000, next.wakes - Date.now()));
    const current = get();
    const asks = keepSame(current.asks, next.asks);
    const withLater = keepSame(current.withLater, next.withLater);
    const soloAsks = keepSame(current.soloAsks, next.soloAsks);
    const needsYou = keepSame(current.needsYou, next.needsYou);
    const answered = keepSame(current.answered, next.answered);
    if (
      asks === current.asks &&
      withLater === current.withLater &&
      soloAsks === current.soloAsks &&
      needsYou === current.needsYou &&
      answered === current.answered
    ) {
      return;
    }
    set({ asks, withLater, soloAsks, needsYou, answered });
  };
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
  useAttentionStore.subscribe((s, previous) => {
    if (s.acknowledged !== previous.acknowledged || s.loaded !== previous.loaded) changed();
  });
  return {
    asks: [],
    withLater: [],
    soloAsks: [],
    needsYou: NOTHING,
    answered: NO_THREADS,
    setQueried(next) {
      queried = next;
      sourced = true;
      derive();
    },
  };
});

/**
 * The one needs-you count: Needs you's items, which the sidebar's pill shows and the window title
 * and the dock badge follow. Every thread that needs the user has at least one (`threadNeedsItems`).
 */
export const needsYouCount = (): number =>
  needsYouCounts(useDerivedAsks.getState().needsYou.groups).total;

/** Back to nothing handed in and nothing derived, as a window starts; for tests. */
export const resetDerivedAsks = () => {
  queried = NO_QUERIED;
  sourced = false;
  clearTimeout(wake);
  wake = undefined;
  useDerivedAsks.setState({
    asks: [],
    withLater: [],
    soloAsks: [],
    needsYou: NOTHING,
    answered: NO_THREADS,
  });
};

/** The workers answered from here and not yet heard from (`DerivedAsks.answered`), as a set. */
export function useAnsweredWorkers(): ReadonlySet<ThreadId> {
  const from = useDerivedAsks((s) => s.answered);
  return useMemo(() => new Set(from), [from]);
}
