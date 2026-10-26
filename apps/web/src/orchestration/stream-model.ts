import {
  streamLinesOf,
  type DeliveredDigest,
  type FeatureCard,
  type GramUIMessage,
  type OrchestrationDigest,
  type StreamLine,
} from "@gram/contracts";

import { formatClockTime } from "@/lib/time";
import { digestTitle } from "@/thread/orchestration-model";
import { isToolPart, toolNameOf } from "@/thread/parts";

// The orchestrator's calm stream (buildout "Make the stream live"): each feature once, as a live
// card that updates in place, and one line for each event the budget lets speak. Pure, so where a
// card sits and what a digest says are tested without a browser.

/** One digest of the orchestrator's transcript, as its quiet line tells it. */
export interface StreamDigest {
  /** The digest's message; its text is what the agent was sent. */
  readonly message: GramUIMessage;
  readonly digest: OrchestrationDigest;
  /** When it was delivered, epoch ms. */
  readonly at: number | undefined;
}

/** What a message of the orchestrator's transcript shows besides, or instead of, itself. */
interface StreamExtras {
  /** The lines its digest speaks; empty for any other message. */
  readonly lines: readonly StreamLine[];
  /** The features whose cards sit here, in the order they were first seen. */
  readonly cards: readonly string[];
  /**
   * The digests its one collapsed digest line stands for, oldest first: on the last digest of a
   * run of digests with no other message between them, the whole run; empty on any other message.
   */
  readonly digests: readonly StreamDigest[];
}

export interface StreamPlan {
  /**
   * The transcript's messages, less each digest folded into a later digest's line that has no
   * line or card of its own to show.
   */
  readonly messages: readonly GramUIMessage[];
  /** By message id, what shows with it. */
  readonly extras: ReadonlyMap<string, StreamExtras>;
  /** The digests in the transcript with when each was delivered, for "Since you left". */
  readonly digests: readonly DeliveredDigest[];
}

/** A message's orchestration digest, if it is one. */
export const digestOf = (message: GramUIMessage): OrchestrationDigest | undefined => {
  if (message.role !== "user") return undefined;
  for (const part of message.parts) {
    if (part.type === "data-orchestration-digest") return part.data;
  }
  return undefined;
};

/** The features the orchestrator spawned workers for in `message` (`spawn_worker` calls). */
export const spawnedFeatures = (message: GramUIMessage): readonly string[] => {
  if (message.role !== "assistant") return [];
  const features: string[] = [];
  for (const part of message.parts) {
    if (!isToolPart(part) || !toolNameOf(part).endsWith("spawn_worker")) continue;
    const input = part.input as { readonly feature?: unknown } | undefined;
    if (typeof input?.feature === "string" && input.feature !== "") features.push(input.feature);
  }
  return features;
};

const NOTHING: StreamExtras = { lines: [], cards: [], digests: [] };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a digest line says, a few words: "Digest #4", "3 reports", "14:12"; folded, "2 digests". */
export interface DigestLineWords {
  readonly title: string;
  /** Its reports, else its changes; absent when it carries neither. */
  readonly count: string | undefined;
  /** When the newest of them was delivered, on the 24-hour clock. */
  readonly time: string | undefined;
}

export function digestLineWords(
  digests: readonly StreamDigest[],
  clock: (at: number) => string = formatClockTime,
): DigestLineWords {
  const newest = digests.at(-1);
  const title =
    newest === undefined || digests.length > 1
      ? plural(digests.length, "digest")
      : digestTitle(newest.digest);
  const reports = digests.reduce((n, each) => n + each.digest.reports.length, 0);
  const changes = digests.reduce((n, each) => n + each.digest.changes.length, 0);
  const count =
    reports > 0 ? plural(reports, "report") : changes > 0 ? plural(changes, "change") : undefined;
  return { title, count, time: newest?.at === undefined ? undefined : clock(newest.at) };
}

/**
 * Where each card sits and what each digest says. A card sits at the first loaded message that
 * spawned a worker for its feature or carried it in a digest, and nowhere else, so a newer version
 * replaces it in place. A card none of the loaded messages anchors sits at the top of the loaded
 * page while it moved since that page began, so a long-finished feature doesn't follow every page.
 * Every digest is told by one quiet, collapsed line; digests with no other message between them
 * share that line, on the last of them, and one folded there with no line or card of its own
 * leaves the stream.
 */
export function planStream(
  messages: readonly GramUIMessage[],
  cards: readonly FeatureCard[],
): StreamPlan {
  const known = new Set(cards.map((card) => card.feature));
  const anchored = new Set<string>();
  const extras = new Map<string, StreamExtras>();
  const kept: GramUIMessage[] = [];
  const digests: DeliveredDigest[] = [];
  let previous: OrchestrationDigest | undefined;
  /** The digests since the last other message, and whether each shows a line or card of its own. */
  let run: { readonly entry: StreamDigest; readonly speaks: boolean }[] = [];
  const folded = new Set<string>();
  const closeRun = () => {
    const last = run.at(-1);
    if (last === undefined) return;
    for (const { entry, speaks } of run) {
      if (entry !== last.entry && !speaks) folded.add(entry.message.id);
    }
    const id = last.entry.message.id;
    extras.set(id, { ...(extras.get(id) ?? NOTHING), digests: run.map(({ entry }) => entry) });
    run = [];
  };
  for (const message of messages) {
    const digest = digestOf(message);
    const here: string[] = [];
    const anchor = (feature: string) => {
      if (!known.has(feature) || anchored.has(feature)) return;
      anchored.add(feature);
      here.push(feature);
    };
    if (digest === undefined) {
      closeRun();
      for (const feature of spawnedFeatures(message)) anchor(feature);
      kept.push(message);
      if (here.length > 0) extras.set(message.id, { ...NOTHING, cards: here });
      continue;
    }
    const at = message.metadata?.createdAt;
    if (at !== undefined) digests.push({ digest, at });
    const lines = streamLinesOf(digest, previous);
    previous = digest;
    for (const feature of digest.features) anchor(feature.feature);
    const speaks = lines.length > 0 || here.length > 0;
    run.push({ entry: { message, digest, at }, speaks });
    kept.push(message);
    if (speaks) extras.set(message.id, { lines, cards: here, digests: [] });
  }
  closeRun();
  const shown = folded.size === 0 ? kept : kept.filter((message) => !folded.has(message.id));
  const first = shown[0];
  const since = first?.metadata?.createdAt ?? 0;
  const loose = cards
    .filter((card) => !anchored.has(card.feature) && card.updatedAt >= since)
    .map((card) => card.feature);
  if (first !== undefined && loose.length > 0) {
    const there = extras.get(first.id) ?? NOTHING;
    extras.set(first.id, { ...there, cards: [...loose, ...there.cards] });
  }
  return { messages: shown, extras, digests };
}
