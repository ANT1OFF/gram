import { privateJsonFile } from "../http/remote-sessions.ts";
import type { MachineSharing } from "./worker-seats.ts";

/**
 * Whose a worker machine is, kept with the machine and not read off whichever workers are on it:
 * the orchestrator it was asked for, how it may be shared, and the picks it was asked with
 * (docs/EMBEDDING.md, "Several workers on one machine"). Written as the machine is asked for and
 * never changed after: a worker taken on by another orchestrator, a worker closed, or a name
 * worked out again leaves it as it was. `worker-placement.ts` decides every placement from it.
 */
export interface MachineClaim {
  /** The orchestrator thread the machine was asked for: the only one that places workers on it. */
  readonly orchestrator: string;
  readonly mode: MachineSharing;
  /** The picks it was asked with, by the provider's choice id. */
  readonly picks: Readonly<Record<string, string>>;
  /**
   * The seat of the worker it was first asked for. An exclusive machine carries that worker and
   * no other, for life: a spawn with another seat is refused there even once it stands empty.
   */
  readonly seat?: string | undefined;
  /**
   * Whether its provider keeps who is on it (`sharing` in its choices as it was asked for). Only
   * then is the provider asked about its seats; one that keeps none is sent no such call.
   */
  readonly seats?: boolean | undefined;
  /**
   * Who has a place on it now: each worker by its seat, a thread with none by `thread:<id>`. Only
   * the placement decision adds one, and only one of these may open a session there. Absent on a
   * claim from before this was kept: whoever is on the machine then is taken as admitted, once.
   */
  readonly occupants?: ReadonlyArray<string> | undefined;
  /** When it was written (epoch ms). */
  readonly at: number;
}

export interface MachineClaims {
  readonly get: (name: string) => MachineClaim | undefined;
  /** Writes a machine's claim. One already there is kept: a claim is never rewritten. */
  readonly claim: (name: string, claim: MachineClaim) => MachineClaim;
  /** Writes who has a place on a machine now (`MachineClaim.occupants`); nothing else of it. */
  readonly occupy: (name: string, occupants: ReadonlyArray<string>) => void;
  /** Forgets a claim: its machine never came, or was given back. */
  readonly forget: (name: string) => void;
  /**
   * Forgets the claims of machines no longer here (`names`: those that are), once they are older
   * than `olderThanMs`: one asked for a moment ago hasn't joined yet.
   */
  readonly prune: (names: ReadonlySet<string>, now: number, olderThanMs?: number) => void;
}

const CLAIMS_FILE = "worker-machine-claims.json";
const CLAIMS_FILE_MOST = 512 * 1024;
const CLAIMS_KEPT_MOST = 1024;
const PRUNE_AFTER_MS = 60 * 60_000;
const OCCUPANTS_MOST = 64;
const MODES: ReadonlySet<string> = new Set(["own", "exclusive", "shared"]);

const claimsOver = (kept: Map<string, MachineClaim>, save: () => void): MachineClaims => ({
  get: (name) => kept.get(name),
  claim: (name, claim) => {
    const before = kept.get(name);
    if (before !== undefined) return before;
    kept.set(name, claim);
    if (kept.size > CLAIMS_KEPT_MOST) kept.delete(kept.keys().next().value!);
    save();
    return claim;
  },
  occupy: (name, occupants) => {
    const before = kept.get(name);
    if (before === undefined) return;
    kept.set(name, { ...before, occupants: [...new Set(occupants)].slice(0, OCCUPANTS_MOST) });
    save();
  },
  forget: (name) => {
    if (kept.delete(name)) save();
  },
  prune: (names, now, olderThanMs = PRUNE_AFTER_MS) => {
    let changed = false;
    for (const [name, claim] of kept)
      if (!names.has(name) && now - claim.at >= olderThanMs) changed = kept.delete(name) || changed;
    if (changed) save();
  },
});

export const memoryMachineClaims = (): MachineClaims => claimsOver(new Map(), () => undefined);

const readClaim = (raw: unknown): MachineClaim | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { orchestrator, mode, picks, at, seat, seats, occupants } = raw as Record<string, unknown>;
  if (
    typeof orchestrator !== "string" ||
    orchestrator === "" ||
    orchestrator.length > 200 ||
    typeof mode !== "string" ||
    !MODES.has(mode) ||
    typeof at !== "number" ||
    !Number.isSafeInteger(at)
  )
    return undefined;
  const read =
    typeof picks === "object" && picks !== null
      ? Object.entries(picks as Record<string, unknown>)
          .slice(0, 8)
          .flatMap(([key, value]) =>
            typeof value === "string" && value.length <= 64 ? [[key, value] as const] : [],
          )
      : [];
  return {
    orchestrator,
    mode: mode as MachineSharing,
    picks: Object.fromEntries(read),
    ...(typeof seat === "string" && seat.length <= 64 ? { seat } : {}),
    ...(seats === true ? { seats: true } : {}),
    ...(Array.isArray(occupants)
      ? {
          occupants: occupants
            .filter((each): each is string => typeof each === "string" && each.length <= 80)
            .slice(0, OCCUPANTS_MOST),
        }
      : {}),
    at,
  };
};

/**
 * `MachineClaims` kept in `worker-machine-claims.json` beside the machines, so a restart doesn't
 * forget whose a machine is. A file that can't be read, or written, leaves the claims in memory:
 * a machine with no claim takes no worker beside the ones on it (`worker-placement.ts`), so
 * losing the file closes machines to sharing; it never opens one.
 */
export const fileMachineClaims = (dataDir: string): MachineClaims => {
  const kept = new Map<string, MachineClaim>();
  let file: ReturnType<typeof privateJsonFile> | undefined;
  try {
    file = privateJsonFile(dataDir, CLAIMS_FILE, CLAIMS_FILE_MOST);
    const read = file.read() as { version?: unknown; claims?: unknown } | undefined;
    if (read?.version === 1 && Array.isArray(read.claims))
      for (const each of read.claims.slice(0, CLAIMS_KEPT_MOST)) {
        const name = (each as { name?: unknown } | null)?.name;
        const claim = readClaim(each);
        if (typeof name === "string" && claim !== undefined) kept.set(name, claim);
      }
  } catch {
    kept.clear();
  }
  const store = file;
  return claimsOver(kept, () => {
    try {
      store?.write({
        version: 1,
        claims: [...kept].map(([name, claim]) => ({ name, ...claim })),
      });
    } catch {
      return;
    }
  });
};

const byDataDir = new Map<string, MachineClaims>();

/**
 * The one set of claims of a Gram that keeps its data in `dataDir`: the planner that writes them
 * and the passes that read them share it. With no data folder (a test), a set of its own.
 */
export const machineClaimsFor = (dataDir: string | undefined): MachineClaims => {
  if (dataDir === undefined) return memoryMachineClaims();
  const before = byDataDir.get(dataDir);
  if (before !== undefined) return before;
  const made = fileMachineClaims(dataDir);
  byDataDir.set(dataDir, made);
  return made;
};
