import { ThreadId, type FeatureCard, type GramUIMessage, type Thread } from "@gram/contracts";
import * as Schema from "effect/Schema";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useAllActivity } from "@/stores/all-activity";

import { CardFactsContext } from "./card-tones";
import { endWordOf, FeatureCardView } from "./feature-card";
import { useRailFacts } from "./feature-sheet";
import { cardRows, planRuns, planStream, quietCard, type StreamPlan } from "./stream-model";
import { UpdateBlock, UpdateRun } from "./update-block";
import { useFeatureCards } from "./use-feature-cards";

const isThreadId = Schema.is(ThreadId);

interface WorkerName {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface OrchestratorStream {
  readonly plan: StreamPlan;
  readonly cards: ReadonlyMap<string, FeatureCard>;
  /** Every worker on a card, longest title first, for linking names in messages. */
  readonly workers: readonly WorkerName[];
  /** The quiet stream (Show all activity off): runs of quiet rows are one line each. */
  readonly quiet?: boolean;
}

const OrchestratorStreamContext = createContext<OrchestratorStream | undefined>(undefined);

export const useOrchestratorStreamContext = () => use(OrchestratorStreamContext);

const NO_STREAM_CARDS: readonly FeatureCard[] = [];
const NO_PLAN: StreamPlan = {
  messages: [],
  extras: new Map(),
  digests: [],
  foldedInto: new Map(),
};

/** The calm stream of an orchestrator thread: `messages` less its folded digests, and what goes with each. */
export function useOrchestratorStream(
  thread: Thread | undefined,
  messages: readonly GramUIMessage[],
): OrchestratorStream | undefined {
  const orchestrator = thread?.role === "orchestrator";
  const cards = useFeatureCards(orchestrator ? thread.workspaceId : undefined);
  const shown = orchestrator ? cards : NO_STREAM_CARDS;
  const all = useAllActivity((s) => thread !== undefined && s.shown.has(thread.id));
  const plan = useMemo(
    () =>
      orchestrator
        ? all
          ? planStream(messages, shown)
          : planRuns(planStream(messages, shown, { quiet: true }), shown)
        : NO_PLAN,
    [orchestrator, messages, shown, all],
  );
  const byFeature = useMemo(() => new Map(shown.map((card) => [card.feature, card])), [shown]);
  const namesKey = shown
    .flatMap((card) => card.workers.map((worker) => `${worker.threadId}\u0000${worker.title}`))
    .toSorted()
    .join("\n");
  const workers = useMemo(
    () =>
      namesKey === ""
        ? []
        : namesKey
            .split("\n")
            .flatMap((entry) => {
              const cut = entry.indexOf("\u0000");
              const threadId = entry.slice(0, cut);
              return cut > 0 && isThreadId(threadId)
                ? [{ threadId, title: entry.slice(cut + 1) }]
                : [];
            })
            .toSorted((a, b) => b.title.length - a.title.length),
    [namesKey],
  );
  return useMemo(
    () => (orchestrator ? { plan, cards: byFeature, workers, quiet: !all } : undefined),
    [orchestrator, plan, byFeature, workers, all],
  );
}

export function OrchestratorStreamProvider({
  stream,
  children,
}: {
  stream: OrchestratorStream | undefined;
  children: ReactNode;
}) {
  const workspaceId = stream?.cards.values().next().value?.workspaceId;
  const facts = useRailFacts(workspaceId);
  return (
    <OrchestratorStreamContext value={stream}>
      <CardFactsContext value={workspaceId === undefined ? undefined : facts}>
        {children}
      </CardFactsContext>
    </OrchestratorStreamContext>
  );
}

/**
 * The update and cards that go with one message of the orchestrator's stream; nothing elsewhere.
 * A run of digests is one update block, its live cards beneath it; in the quiet stream a run of
 * quiet rows is one line that opens on each (`UpdateRun`).
 */
export function StreamExtrasView({
  messageId,
  renderReply,
}: {
  messageId: string;
  /** Draws a reply a quiet update folds, as the transcript draws a message. */
  renderReply?: (reply: GramUIMessage) => ReactNode;
}) {
  const stream = useOrchestratorStreamContext();
  const extras = stream?.plan.extras.get(messageId);
  if (stream === undefined || extras === undefined) return null;
  const titleOf = (threadId: ThreadId) =>
    stream.workers.find((worker) => worker.threadId === threadId)?.title;
  const endWord = (feature: string) => {
    const card = stream.cards.get(feature);
    return card === undefined ? "merged" : endWordOf(card);
  };
  const cardOf = (feature: string) => {
    const card = stream.cards.get(feature);
    return card === undefined ? null : (
      <FeatureCardView key={feature} card={card} workerTitle={titleOf} />
    );
  };
  return (
    <div data-testid="stream-extras" className="mt-3 flex flex-col gap-3 first:mt-0">
      {extras.run === undefined ? (
        <UpdateBlock
          lines={extras.lines}
          digests={extras.digests}
          replies={extras.replies}
          renderReply={renderReply}
        />
      ) : (
        <UpdateRun
          parts={extras.run}
          renderMerged={cardOf}
          renderReply={renderReply}
          endWord={endWord}
        />
      )}
      {cardRows(extras.cards, (feature) => {
        const card = stream.cards.get(feature);
        return stream.quiet === true && card !== undefined && quietCard(card);
      }).map((row) =>
        row.kind === "card" ? (
          cardOf(row.feature)
        ) : (
          <UpdateRun
            key={`run:${row.parts.map((part) => (part.kind === "merged" ? part.feature : "")).join(" ")}`}
            parts={row.parts}
            renderMerged={cardOf}
            endWord={endWord}
          />
        ),
      )}
    </div>
  );
}
