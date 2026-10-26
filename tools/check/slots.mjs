// Machine-wide check slots, so full checks from several worktrees on one machine take turns
// instead of all running at once and pushing each other's tests into their timeouts.
//
// A slot is a directory under one per-user location (not the session's TMPDIR, which can differ
// per agent session). `mkdir` claims it atomically; the owner's pid lets a later check reclaim
// a slot whose holder died without releasing it.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

/** Where the slots live: `GRAM_CHECK_SLOT_DIR`, else the user's cache directory. */
export function slotDir(env = process.env) {
  if (env["GRAM_CHECK_SLOT_DIR"]) return env["GRAM_CHECK_SLOT_DIR"];
  const cache = env["XDG_CACHE_HOME"] || join(homedir(), ".cache");
  return join(cache, "gram", "check-slots");
}

/**
 * How many full checks may run at once: `GRAM_CHECK_SLOTS`, else one per eight cores. Each check's
 * Vitest uses its share of the cores (`workersPerSlot`), so two checks on an 18-core machine
 * finish sooner side by side than five do thrashing.
 */
export function slotCount(env = process.env, cores = availableParallelism()) {
  const configured = env["GRAM_CHECK_SLOTS"];
  if (configured !== undefined && configured !== "") {
    const n = Number(configured);
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid GRAM_CHECK_SLOTS "${configured}"`);
    return n;
  }
  return Math.max(1, Math.floor(cores / 8));
}

/** Vitest workers for one check holding a slot: its share of the cores, between 2 and 8. */
export function workersPerSlot(slots, cores = availableParallelism()) {
  return Math.min(8, Math.max(2, Math.floor((cores - 2) / slots)));
}

/** Whether `pid` is a live process this user can see. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const readOwner = (path) => {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  } catch {
    return undefined;
  }
};

/** A slot's holder is gone: its pid is dead, or it never wrote an owner within `graceMs`. */
function stale(path, now, graceMs) {
  const owner = readOwner(path);
  if (owner && Number.isInteger(owner.pid)) {
    return owner.host !== hostname() ? false : !alive(owner.pid);
  }
  try {
    return now - statSync(path).mtimeMs > graceMs;
  } catch {
    return false;
  }
}

/** The current holders, for the waiting message. */
export function holders(dir = slotDir()) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith("slot-"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const owner = readOwner(join(dir, name));
    return owner ? [owner] : [];
  });
}

/** One attempt: the claimed slot's path, or undefined when every slot is held by a live check. */
export function tryClaim({ dir, slots, owner, now = Date.now(), graceMs = 30_000 }) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const path = join(dir, `slot-${i}`);
    try {
      mkdirSync(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!stale(path, now, graceMs)) continue;
      // Reclaim: remove the dead holder's slot, then race for it like anyone else.
      rmSync(path, { recursive: true, force: true });
      try {
        mkdirSync(path);
      } catch (retry) {
        if (retry.code === "EEXIST") continue;
        throw retry;
      }
    }
    writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
    return path;
  }
  return undefined;
}

/** Frees `path` when this process still holds it. */
function release(path, pid = process.pid) {
  if (readOwner(path)?.pid === pid) rmSync(path, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a free slot and resolves with its release function. `onWait` hears once who holds the
 * slots. The slot is freed on exit and on SIGINT/SIGTERM, so an interrupted check never holds it.
 */
export async function acquireSlot({
  dir = slotDir(),
  slots = slotCount(),
  label = process.cwd(),
  pollMs = 1000,
  onWait = () => {},
} = {}) {
  const owner = { pid: process.pid, host: hostname(), cwd: label, since: new Date().toISOString() };
  let path = tryClaim({ dir, slots, owner });
  if (path === undefined) {
    onWait(holders(dir));
    while (path === undefined) {
      await sleep(pollMs);
      path = tryClaim({ dir, slots, owner });
    }
  }
  const claimed = path;
  const free = () => release(claimed);
  const onSignal = (signal) => {
    free();
    process.kill(process.pid, signal);
  };
  process.once("exit", free);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("exit", free);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    free();
  };
}

/**
 * Where a checkout's running check says who it is, so `bun run check:cancel` stops that one check
 * and its children, never a process another worktree started (as a `pkill -f` pattern would).
 */
export function runFile(root, dir = slotDir()) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(dirname(dir), "check-runs", `${key}.json`);
}

/** Records this process as `root`'s running check, with the process groups of its stages. */
export function writeRun(root, run, dir = slotDir()) {
  const path = runFile(root, dir);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify({ ...run, root, host: hostname() }));
  renameSync(partial, path);
}

/** `root`'s running check, when one is recorded for exactly that checkout on this machine. */
export function readRun(root, dir = slotDir()) {
  try {
    const run = JSON.parse(readFileSync(runFile(root, dir), "utf8"));
    return run.root === root && run.host === hostname() && Number.isInteger(run.pid)
      ? run
      : undefined;
  } catch {
    return undefined;
  }
}

/** Forgets `root`'s running check, when it is still this process's record. */
export function clearRun(root, pid = process.pid, dir = slotDir()) {
  if (readRun(root, dir)?.pid === pid) rmSync(runFile(root, dir), { force: true });
}
