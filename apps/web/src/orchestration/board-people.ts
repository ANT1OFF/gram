import type { PeopleNames, ThreadId } from "@gram/contracts";

import type { RailRow, RailWorker } from "./rail-model";

/** A person's key: their subject, or `""` for work done for nobody. */
export type PersonKey = string;

const NOBODY: PersonKey = "";

/** What the people strip says of one person. */
export interface BoardPerson {
  readonly key: PersonKey;
  readonly features: number;
  readonly needs: number;
  /** Their workers to name, what needs them first, then what runs, then what waits. */
  readonly workers: readonly RailWorker[];
}

/** Two people's workers that change the same files. */
export interface BoardClash {
  readonly a: { readonly person: PersonKey; readonly worker: ThreadId; readonly title: string };
  readonly b: { readonly person: PersonKey; readonly worker: ThreadId; readonly title: string };
  readonly files: readonly string[];
}

const workersOf = (row: RailRow) => row.card.workers;

/** Whom each worker on the Board works for, by thread. */
export const personByWorker = (rows: readonly RailRow[]): ReadonlyMap<ThreadId, PersonKey> =>
  new Map(
    rows.flatMap((row) =>
      workersOf(row).map((worker) => [worker.threadId, worker.startedBy ?? NOBODY] as const),
    ),
  );

/** The people a line's workers work for, in the order they appear, each once. */
export const ownersOf = (row: RailRow): readonly PersonKey[] => [
  ...new Set(workersOf(row).map((worker) => worker.startedBy ?? NOBODY)),
];

/** Whether the Board has more than one person's work on it: only then does it say whose. */
export const sharedBoard = (rows: readonly RailRow[]): boolean =>
  new Set(rows.flatMap(ownersOf)).size > 1;

const TONE_ORDER: Readonly<Record<RailWorker["tone"], number>> = {
  needs: 0,
  error: 1,
  working: 2,
  waiting: 3,
  attention: 4,
  idle: 5,
  merged: 6,
};

/** Each person with work on the Board, you first, then by how much waits on them. */
export const boardPeople = (
  rows: readonly RailRow[],
  you: PersonKey | undefined,
): BoardPerson[] => {
  const people = new Map<PersonKey, { features: Set<string>; workers: RailWorker[] }>();
  const person = personByWorker(rows);
  for (const row of rows) {
    for (const worker of Object.values(row.cells).flat()) {
      const key = person.get(worker.threadId) ?? NOBODY;
      const entry = people.get(key) ?? { features: new Set(), workers: [] };
      entry.features.add(row.feature);
      entry.workers.push(worker);
      people.set(key, entry);
    }
  }
  return [...people]
    .map(([key, { features, workers }]) => ({
      key,
      features: features.size,
      needs: workers.filter((worker) => worker.tone === "needs").length,
      workers: workers.toSorted((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]),
    }))
    .toSorted(
      (a, b) =>
        Number(b.key === you) - Number(a.key === you) ||
        b.needs - a.needs ||
        b.features - a.features ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
};

/** The lines that hold work for `key`; every line when no one is picked. */
export const rowsFor = (rows: readonly RailRow[], key: PersonKey | undefined): RailRow[] =>
  key === undefined ? [...rows] : rows.filter((row) => ownersOf(row).includes(key));

/**
 * Where two people's workers change the same files (the card's advisory overlap), each pair once,
 * yours first. One person's own overlaps are the orchestrator's to sort out and are left out.
 */
export const boardClashes = (
  rows: readonly RailRow[],
  you: PersonKey | undefined,
): BoardClash[] => {
  const person = personByWorker(rows);
  const titles = new Map(
    rows.flatMap((row) => workersOf(row).map((worker) => [worker.threadId, worker.title] as const)),
  );
  const seen = new Set<string>();
  const clashes: BoardClash[] = [];
  for (const row of rows) {
    for (const worker of workersOf(row)) {
      const mine = person.get(worker.threadId) ?? NOBODY;
      for (const other of worker.overlapsWith) {
        const theirs = person.get(other);
        if (theirs === undefined || theirs === mine) continue;
        const key = [worker.threadId, other].toSorted().join(" ");
        if (seen.has(key)) continue;
        seen.add(key);
        const side = (id: ThreadId, who: PersonKey) => ({
          person: who,
          worker: id,
          title: titles.get(id) ?? "",
        });
        const pair = [side(worker.threadId, mine), side(other, theirs)] as const;
        const [a, b] = pair[1].person === you ? [pair[1], pair[0]] : pair;
        clashes.push({ a, b, files: worker.overlapFiles });
      }
    }
  }
  return clashes.toSorted((x, y) => Number(y.a.person === you) - Number(x.a.person === you));
};

/** What a person is called on the Board: "You", their name, or "Someone else". */
export const personName = (
  key: PersonKey,
  names: PeopleNames | undefined,
  { capital = true }: { capital?: boolean } = {},
): string => {
  if (key !== NOBODY && key === names?.you) return capital ? "You" : "you";
  const name = names?.people.find((person) => person.id === key)?.name;
  return name ?? (capital ? "Someone else" : "someone else");
};

/** A line's owners in words: "Grace", "Grace, you". */
export const ownersText = (keys: readonly PersonKey[], names: PeopleNames | undefined): string =>
  keys
    .toSorted((a, b) => Number(a === names?.you) - Number(b === names?.you))
    .map((key, index) => personName(key, names, { capital: index === 0 }))
    .join(", ");
