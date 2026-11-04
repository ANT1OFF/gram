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

/** A line a digest spoke, with when that digest was delivered. */
export interface TimedLine {
  readonly line: StreamLine;
  /** Epoch ms; absent when the digest's message doesn't say. */
  readonly at: number | undefined;
}

/** What a message of the orchestrator's transcript shows besides, or instead of, itself. */
interface StreamExtras {
  /** The lines its run of digests speaks, oldest first; empty for any other message. */
  readonly lines: readonly TimedLine[];
  /** The features whose cards sit here, in the order they were first seen. */
  readonly cards: readonly string[];
  /**
   * The digests its one update stands for, oldest first: on the last digest of a run of digests
   * with no other message between them, the whole run; empty on any other message.
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
 * A run of digests with no other message between them is one update: its lines, its cards and its
 * digests all gather on the last digest of the run, in order, and the others leave the stream, so
 * consecutive background events read as one block rather than a stack of similar ones. Nothing is
 * dropped: every line and digest of the run is in that one update.
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
  /** The digests since the last other message, with the lines and cards each brought. */
  let run: {
    readonly entry: StreamDigest;
    readonly lines: readonly TimedLine[];
    readonly cards: readonly string[];
  }[] = [];
  const folded = new Set<string>();
  const closeRun = () => {
    const last = run.at(-1);
    if (last === undefined) return;
    for (const { entry } of run) {
      if (entry !== last.entry) folded.add(entry.message.id);
    }
    extras.set(last.entry.message.id, {
      lines: run.flatMap((each) => each.lines),
      cards: run.flatMap((each) => each.cards),
      digests: run.map(({ entry }) => entry),
    });
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
    const lines = streamLinesOf(digest, previous).map((line) => ({ line, at }));
    previous = digest;
    for (const feature of digest.features) anchor(feature.feature);
    run.push({ entry: { message, digest, at }, lines, cards: here });
    kept.push(message);
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

/** One count in an update's header: "2 merged", toned as its lines are. */
export interface UpdateCount {
  readonly kind: StreamLine["kind"];
  readonly text: string;
}

/** What an update's one header line says: its counts, else its digests' words, and its time. */
export interface UpdateWords {
  /** By kind, what needs the user first: "1 waiting on you", "1 failed", then "2 merged". */
  readonly counts: readonly UpdateCount[];
  /** The digests' own words when no line spoke: "Digest #4 · 3 reports". */
  readonly digest: DigestLineWords;
  /** When its newest event was delivered, on the 24-hour clock. */
  readonly time: string | undefined;
  /** A line in it asks for the user or failed: it opens by itself, and its header says so. */
  readonly needsYou: boolean;
}

const COUNT_ORDER: readonly StreamLine["kind"][] = [
  "ask",
  "failed",
  "merged",
  "delivered",
  "paused",
];

const COUNT_WORDS: Readonly<Record<StreamLine["kind"], string>> = {
  ask: "waiting on you",
  failed: "failed",
  merged: "merged",
  delivered: "delivered",
  paused: "paused",
};

export function updateWords(
  lines: readonly TimedLine[],
  digests: readonly StreamDigest[],
  clock: (at: number) => string = formatClockTime,
): UpdateWords {
  const byKind = new Map<StreamLine["kind"], number>();
  for (const { line } of lines) byKind.set(line.kind, (byKind.get(line.kind) ?? 0) + 1);
  const counts = COUNT_ORDER.flatMap((kind) => {
    const n = byKind.get(kind);
    return n === undefined ? [] : [{ kind, text: `${n} ${COUNT_WORDS[kind]}` }];
  });
  const digest = digestLineWords(digests, clock);
  const newest = Math.max(
    ...lines.flatMap(({ at }) => (at === undefined ? [] : [at])),
    ...digests.flatMap(({ at }) => (at === undefined ? [] : [at])),
  );
  return {
    counts,
    digest,
    time: Number.isFinite(newest) ? clock(newest) : undefined,
    needsYou: byKind.has("ask") || byKind.has("failed"),
  };
}
