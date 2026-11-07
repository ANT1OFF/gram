import type { FeatureCard, GramUIMessage, Thread, ThreadId } from "@gram/contracts";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useAllActivity } from "@/stores/all-activity";

import { FeatureCardView } from "./feature-card";
import { planStream, type StreamPlan } from "./stream-model";
import { UpdateBlock } from "./update-block";
import { useFeatureCards } from "./use-feature-cards";

/** A worker's name as orchestrator messages link it. */
interface WorkerName {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface OrchestratorStream {
  readonly plan: StreamPlan;
  readonly cards: ReadonlyMap<string, FeatureCard>;
  /** Every worker on a card, longest title first, for linking names in messages. */
  readonly workers: readonly WorkerName[];
}

/**
 * Present only in an orchestrator's transcript: a digest message there shows the lines it speaks,
 * the cards it anchors and a quiet, collapsed digest line instead of its own card, and worker names
 * in messages are links.
 */
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
  // Quiet unless the user asked for all of it: what changed nothing for them folds into its update.
  const all = useAllActivity((s) => thread !== undefined && s.shown.has(thread.id));
  const plan = useMemo(
    () => (orchestrator ? planStream(messages, shown, { quiet: !all }) : NO_PLAN),
    [orchestrator, messages, shown, all],
  );
  const byFeature = useMemo(() => new Map(shown.map((card) => [card.feature, card])), [shown]);
  // Keyed by the names alone, so a card's new version doesn't re-render every message's markdown.
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
            .map((entry) => {
              const [threadId, title] = entry.split("\u0000") as [ThreadId, string];
              return { threadId, title };
            })
            .toSorted((a, b) => b.title.length - a.title.length),
    [namesKey],
  );
  return useMemo(
    () => (orchestrator ? { plan, cards: byFeature, workers } : undefined),
    [orchestrator, plan, byFeature, workers],
  );
}

export function OrchestratorStreamProvider({
  stream,
  children,
}: {
  stream: OrchestratorStream | undefined;
  children: ReactNode;
}) {
  return <OrchestratorStreamContext value={stream}>{children}</OrchestratorStreamContext>;
}

/**
 * The update and cards that go with one message of the orchestrator's stream; nothing elsewhere.
 * A run of digests is one update block, its live cards beneath it.
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
  return (
    // A reply's block step (12 px) between the update and its cards, and after the message above.
    <div data-testid="stream-extras" className="mt-3 flex flex-col gap-3 first:mt-0">
      <UpdateBlock
        lines={extras.lines}
        digests={extras.digests}
        replies={extras.replies}
        renderReply={renderReply}
      />
      {extras.cards.map((feature) => {
        const card = stream.cards.get(feature);
        return card === undefined ? null : (
          <FeatureCardView key={feature} card={card} workerTitle={titleOf} />
        );
      })}
    </div>
  );
}
