import {
  streamLinesOf,
  type DeliveredDigest,
  type FeatureCard,
  type GramUIMessage,
  type OrchestrationDigest,
  type StreamLine,
} from "@gram/contracts";

import { formatStamp } from "@/lib/time";
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
  /**
   * In a quiet stream, the orchestrator's replies folded into this update because nothing in their
   * episodes changed for the user, oldest first; absent everywhere else.
   */
  readonly replies?: readonly GramUIMessage[];
  /**
   * In a quiet stream, the run of quiet rows this message's one row stands for (`foldRuns`), in the
   * order they stood: shown as one line, "Updates · 3 merged · 1 report", that opens on each. Its
   * own update is among them, so `lines` and `digests` are then empty, and `cards` are only those
   * that came after the run.
   */
  readonly run?: readonly RunPart[];
}

/** One row of a run of quiet rows: an update, or a merged feature's line. */
export type RunPart =
  | {
      readonly kind: "update";
      /** The message the update stood on. */
      readonly messageId: string;
      readonly lines: readonly TimedLine[];
      readonly digests: readonly StreamDigest[];
      readonly replies?: readonly GramUIMessage[];
    }
  | { readonly kind: "merged"; readonly feature: string };

/**
 * Whether a feature's card is a quiet line rather than a card: merged, with no brief held for it,
 * so nothing on it moves any more.
 */
export const quietCard = (card: Pick<FeatureCard, "station" | "held">): boolean =>
  card.station === "merged" && card.held === undefined;

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
  /**
   * In a quiet stream, the anchor each folded message went to, by its id: what a search or a jump
   * to a folded message opens. Empty with folding off.
   */
  readonly foldedInto: ReadonlyMap<string, string>;
}

export interface PlanOptions {
  /**
   * Fold what changed nothing for the user (`quietEpisodes`): the default view of an
   * orchestrator's chat. Off, "Show all activity", every reply stands as it was.
   */
  readonly quiet?: boolean;
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
  clock: (at: number) => string = formatStamp,
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
  { quiet = false }: PlanOptions = {},
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
  const unfolded = folded.size === 0 ? kept : kept.filter((message) => !folded.has(message.id));
  const foldedInto = new Map<string, string>();
  const shown = quiet ? foldQuiet(unfolded, extras, foldedInto) : unfolded;
  const first = shown[0];
  const since = first?.metadata?.createdAt ?? 0;
  const loose = cards
    .filter((card) => !anchored.has(card.feature) && card.updatedAt >= since)
    .map((card) => card.feature);
  if (first !== undefined && loose.length > 0) {
    const there = extras.get(first.id) ?? NOTHING;
    extras.set(first.id, { ...there, cards: [...loose, ...there.cards] });
  }
  return { messages: shown, extras, digests, foldedInto };
}

/**
 * The quiet stream's plan with each run of quiet rows as one row (`foldRuns`): the default view of
 * an orchestrator's chat, over `planStream`'s quiet plan. `cards` say which features are merged
 * lines. The plan it is given is left as it was.
 */
export function planRuns(plan: StreamPlan, cards: readonly FeatureCard[]): StreamPlan {
  const extras = new Map(plan.extras);
  const foldedInto = new Map(plan.foldedInto);
  const merged = new Set(cards.filter(quietCard).map((card) => card.feature));
  const messages = foldRuns(plan.messages, extras, merged, foldedInto);
  return messages === undefined ? plan : { ...plan, messages, extras, foldedInto };
}

/**
 * A run of quiet rows as one row (the quiet stream only). The rows of the stream, in order, are each
 * message's own (a reply or the user's, never quiet), a digest's update, then the feature cards it
 * anchors; an update and a merged feature's line are quiet. Two or more quiet rows in a row, at
 * least one an update, with no reply or message of the user's between them, become one row on the
 * last update's message, and every message the run took whole leaves the stream (a search for one
 * opens all activity, as for a folded reply). A lone update stays as it is, and so does a merged
 * line beside a reply only; a live card ends a run, since it is not quiet. Undefined when it found
 * no run, and changed nothing.
 */
function foldRuns(
  messages: readonly GramUIMessage[],
  extras: Map<string, StreamExtras>,
  merged: ReadonlySet<string>,
  foldedInto: Map<string, string>,
): readonly GramUIMessage[] | undefined {
  let runs = 0;
  /** The quiet rows so far, each with the message it came from. */
  let pending: { readonly part: RunPart; readonly from: string }[] = [];
  /** Each message a run took whole, with the message its row went to. */
  const removed = new Map<string, string>();
  const flush = () => {
    const run = pending;
    pending = [];
    const anchor = run.findLast(({ part }) => part.kind === "update")?.from;
    if (run.length < 2 || anchor === undefined) return;
    runs += 1;
    const taken = new Map<string, Set<string>>();
    for (const { part, from } of run) {
      if (part.kind === "update" && from !== anchor) removed.set(from, anchor);
      if (part.kind === "merged") {
        const features = taken.get(from) ?? new Set<string>();
        features.add(part.feature);
        taken.set(from, features);
      }
    }
    // A message the run took part of keeps what wasn't quiet: a reply, a live card, a later line.
    for (const [from, features] of taken) {
      if (removed.has(from) || from === anchor) continue;
      const own = extras.get(from);
      if (own !== undefined)
        extras.set(from, { ...own, cards: own.cards.filter((card) => !features.has(card)) });
    }
    const own = extras.get(anchor) ?? NOTHING;
    const inRun = taken.get(anchor) ?? new Set<string>();
    extras.set(anchor, {
      lines: [],
      digests: [],
      cards: own.cards.filter((card) => !inRun.has(card)),
      run: run.map(({ part }) => part),
    });
  };
  for (const message of messages) {
    const own = extras.get(message.id);
    const update = digestOf(message) !== undefined && own !== undefined && own.digests.length > 0;
    if (!update) flush();
    else
      pending.push({
        from: message.id,
        part: {
          kind: "update",
          messageId: message.id,
          lines: own.lines,
          digests: own.digests,
          ...(own.replies === undefined ? {} : { replies: own.replies }),
        },
      });
    for (const feature of own?.cards ?? []) {
      if (merged.has(feature))
        pending.push({ from: message.id, part: { kind: "merged", feature } });
      else flush();
    }
  }
  flush();
  if (runs === 0) return undefined;
  // What a quiet update had folded goes where that update went.
  for (const [id, target] of foldedInto) {
    const moved = removed.get(target);
    if (moved !== undefined) foldedInto.set(id, moved);
  }
  for (const [id, target] of removed) {
    foldedInto.set(id, target);
    extras.delete(id);
  }
  return messages.filter((message) => !removed.has(message.id));
}

/** What makes an update one the user should read: a merge, a delivery, a failure, a question. */
const NOTABLE: ReadonlySet<StreamLine["kind"]> = new Set(["merged", "delivered", "failed", "ask"]);

/** A reply that asks the user something is never folded, whatever its digest said. */
const asksUser = (message: GramUIMessage): boolean =>
  message.parts.some((part) => isToolPart(part) && toolNameOf(part).endsWith("ask_user"));

/**
 * Whether a run of digests, with the orchestrator's replies to it, changed nothing for the user:
 * no line merged, delivered, failed or asks, none of its digests is a boot or an away digest (the
 * reply to one is what the user reads when they come back), and no reply asks them anything.
 */
export const quietEpisode = (extras: StreamExtras, replies: readonly GramUIMessage[]): boolean =>
  extras.digests.length > 0 &&
  !extras.lines.some(({ line }) => NOTABLE.has(line.kind)) &&
  !extras.digests.some(
    ({ digest }) =>
      digest.variant === "boot" ||
      digest.variant === "away" ||
      digest.userAwayMinutes !== undefined,
  ) &&
  !replies.some(asksUser);

/**
 * The quiet stream: each digest's episode (its run of digests and the orchestrator's replies up to
 * the next message of the user's) that changed nothing for the user folds into its update, and
 * quiet episodes in a row share one update, on the last digest of the last of them. Their lines,
 * cards, digests and replies all go with it, so the update opens on everything; only where it
 * shows changes. An episode with a merge, a failure or a question stands as it is.
 */
function foldQuiet(
  messages: readonly GramUIMessage[],
  extras: Map<string, StreamExtras>,
  foldedInto: Map<string, string>,
): readonly GramUIMessage[] {
  const shown: GramUIMessage[] = [];
  /** The quiet episodes in a row so far: their digests (the anchors) and replies, in order. */
  let group: GramUIMessage[] = [];
  const closeGroup = () => {
    const anchors = group.filter((message) => digestOf(message) !== undefined);
    const anchor = anchors.at(-1);
    if (anchor === undefined) return;
    const lines: TimedLine[] = [];
    const cards: string[] = [];
    const digests: StreamDigest[] = [];
    const replies: GramUIMessage[] = [];
    for (const message of group) {
      const own = extras.get(message.id);
      lines.push(...(own?.lines ?? []));
      cards.push(...(own?.cards ?? []));
      digests.push(...(own?.digests ?? []));
      if (digestOf(message) === undefined) replies.push(message);
      if (message !== anchor) {
        foldedInto.set(message.id, anchor.id);
        extras.delete(message.id);
      }
    }
    // Digests no reply answered read as they did: only replies make the update a quiet one.
    extras.set(anchor.id, { lines, cards, digests, ...(replies.length > 0 ? { replies } : {}) });
    shown.push(anchor);
    group = [];
  };
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const own = extras.get(message.id);
    if (digestOf(message) === undefined || own === undefined) {
      closeGroup();
      shown.push(message);
      index += 1;
      continue;
    }
    // The episode: this digest and the replies after it, up to the next message of the user's.
    let end = index + 1;
    while (end < messages.length && messages[end]!.role !== "user") end += 1;
    const replies = messages.slice(index + 1, end);
    if (quietEpisode(own, replies)) {
      group.push(message, ...replies);
    } else {
      closeGroup();
      shown.push(message, ...replies);
    }
    index = end;
  }
  closeGroup();
  return shown;
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
  clock: (at: number) => string = formatStamp,
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

/** A message's cards as they show: each live card, and each run of merged lines as one row. */
export type CardRow =
  | { readonly kind: "card"; readonly feature: string }
  | { readonly kind: "run"; readonly parts: readonly RunPart[] };

/**
 * A message's cards in order, with two or more merged lines in a row as one run (`UpdateRun`), as a
 * run of updates is: a page that opens on a morning's merges reads one line, "6 merged", rather than
 * a stack of them. A lone merged line, and every live card, stands as it is.
 */
export function cardRows(
  features: readonly string[],
  merged: (feature: string) => boolean,
): CardRow[] {
  const rows: CardRow[] = [];
  let quiet: string[] = [];
  const flush = () => {
    if (quiet.length === 1) rows.push({ kind: "card", feature: quiet[0]! });
    if (quiet.length > 1)
      rows.push({ kind: "run", parts: quiet.map((feature) => ({ kind: "merged", feature })) });
    quiet = [];
  };
  for (const feature of features) {
    if (merged(feature)) quiet.push(feature);
    else {
      flush();
      rows.push({ kind: "card", feature });
    }
  }
  flush();
  return rows;
}

/** What a run's one row says: "09:56–09:59 Updates · 1 waiting on you · 3 merged · 1 report". */
export interface RunWords {
  /** As an update's: what needs the user first, each toned as its lines are. */
  readonly counts: readonly UpdateCount[];
  /** Its digests' reports, else their changes: "1 report"; absent when they carry neither. */
  readonly digest: string | undefined;
  /** When its first and last updates came, "09:56–09:59", or one time when they are the same. */
  readonly time: string | undefined;
  /** An update in it asks for the user or failed: its words say so, in amber or red. */
  readonly needsYou: boolean;
}

/**
 * The words of a run's one row, summed over every row it holds, so nothing in it goes unsaid: an
 * ask or a failure inside it is counted on the row, toned. A merged line counts as merged unless
 * an update in the run already said that feature merged.
 */
export function runWords(
  parts: readonly RunPart[],
  clock: (at: number) => string = formatStamp,
): RunWords {
  const updates = parts.flatMap((part) => (part.kind === "update" ? [part] : []));
  const lines = updates.flatMap((part) => part.lines);
  const digests = updates.flatMap((part) => part.digests);
  const said = new Set(
    lines.flatMap(({ line }) =>
      line.kind === "merged" && line.feature !== "" ? [line.feature] : [],
    ),
  );
  const byKind = new Map<StreamLine["kind"], number>();
  for (const { line } of lines) byKind.set(line.kind, (byKind.get(line.kind) ?? 0) + 1);
  for (const part of parts) {
    if (part.kind === "merged" && !said.has(part.feature))
      byKind.set("merged", (byKind.get("merged") ?? 0) + 1);
  }
  const counts = COUNT_ORDER.flatMap((kind) => {
    const n = byKind.get(kind);
    return n === undefined ? [] : [{ kind, text: `${n} ${COUNT_WORDS[kind]}` }];
  });
  const times = updates.flatMap((part) => [
    ...part.lines.flatMap(({ at }) => (at === undefined ? [] : [at])),
    ...part.digests.flatMap(({ at }) => (at === undefined ? [] : [at])),
    ...(part.replies ?? []).flatMap((reply) => reply.metadata?.createdAt ?? []),
  ]);
  const first = times.length === 0 ? undefined : clock(Math.min(...times));
  const last = times.length === 0 ? undefined : clock(Math.max(...times));
  return {
    counts,
    digest: digestLineWords(digests, clock).count,
    time: first === last ? first : `${first}–${last}`,
    needsYou: byKind.has("ask") || byKind.has("failed"),
  };
}

/** The longest preview a quiet update's header carries; the line truncates it further to fit. */
const PREVIEW_MAX = 160;

/**
 * A quiet update's preview: the first line the newest of its replies says, in plain words (its
 * markdown marks and link targets dropped), so the one updating line reads where things stand,
 * "The release build is 23 minutes in…". Undefined when no reply says anything yet.
 */
export function replyPreview(replies: readonly GramUIMessage[] | undefined): string | undefined {
  for (const reply of (replies ?? []).toReversed()) {
    const text = reply.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const line = text
      .split("\n")
      .map((each) =>
        each
          .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
          .replace(/[*_`~]+/gu, "")
          .replace(/^\s*(?:#+|>|[-+]|\d+\.)\s+/u, "")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .find((each) => each !== "");
    if (line !== undefined)
      return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
  }
  return undefined;
}
