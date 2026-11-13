import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TerminalId, ThreadId } from "@gram/contracts";

import { plainTail } from "./plain-text.ts";
import { replayable } from "./scrollback.ts";

/**
 * The line a kept terminal's fresh shell opens under, below the old screen. The old program is
 * never run again: the shell is new, and so is everything below the line.
 */
export const KEPT_DIVIDER = "the program above ended; this is a new shell";

/**
 * The folder the server that starts this machine's host names for its kept terminals, in its own
 * data folder, so two Grams on one machine (a release and a checkout) never show each other's.
 */
export const KEPT_TERMINALS_ENV = "GRAM_HOST_KEPT_TERMINALS";

/** How many lines of the old screen and its scrollback come back above the divider. */
export const KEPT_LINES = 1_000;

/** What a host keeps of a thread's open terminal, so a restart can show it again. */
export interface KeptTerminal {
  readonly terminalId: TerminalId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** The shell's executable, which the fresh shell runs again. Never the command a script ran. */
  readonly shell: string;
  /** The PATH the shell had, so the fresh one finds what the old one did. */
  readonly path: string;
  readonly cols: number;
  readonly rows: number;
  /** The raw output kept, as `Scrollback.toReplay` gives it. */
  readonly tail: string;
  /** Output older than `tail` was dropped at the scrollback cap. */
  readonly cut: boolean;
}

/** Where a host keeps its open terminals' tails, one file per terminal. */
export interface KeptTerminals {
  write(kept: KeptTerminal): void;
  remove(terminalId: TerminalId): void;
  /** Every terminal kept, each removed as it is read: one that fails to come back isn't tried again. */
  takeAll(): ReadonlyArray<KeptTerminal>;
}

const FILE = /^[0-9a-f-]{36}\.json$/;

const isKept = (value: unknown): value is KeptTerminal => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["terminalId"] === "string" &&
    typeof v["threadId"] === "string" &&
    typeof v["cwd"] === "string" &&
    typeof v["shell"] === "string" &&
    typeof v["path"] === "string" &&
    typeof v["tail"] === "string" &&
    typeof v["cut"] === "boolean" &&
    Number.isInteger(v["cols"]) &&
    Number.isInteger(v["rows"]) &&
    (v["cols"] as number) > 0 &&
    (v["rows"] as number) > 0
  );
};

/**
 * Terminal tails kept in `dir`, readable by the user alone: a terminal shows whatever ran in it.
 * A write is a whole file renamed into place, so a crash mid-write leaves the last one whole.
 */
export const keptTerminalsIn = (dir: string): KeptTerminals => {
  const fileOf = (terminalId: TerminalId) => join(dir, `${terminalId}.json`);
  const ensure = () => mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    write: (kept) => {
      ensure();
      const file = fileOf(kept.terminalId);
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(kept), { mode: 0o600 });
      renameSync(temp, file);
    },
    remove: (terminalId) => rmSync(fileOf(terminalId), { force: true }),
    takeAll: () => {
      let names: Array<string>;
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const all: Array<KeptTerminal> = [];
      for (const name of names) {
        const file = join(dir, name);
        if (name.endsWith(".tmp")) {
          rmSync(file, { force: true });
          continue;
        }
        if (!FILE.test(name)) continue;
        try {
          const value: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (isKept(value) && `${value.terminalId}.json` === name) all.push(value);
        } catch {
          // Unreadable: dropped below like any other.
        }
        rmSync(file, { force: true });
      }
      return all;
    },
  };
};

/** Leaves whatever mode the old program left on, so the new shell starts on a plain screen. */
const RESET = "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m";

/**
 * What a kept terminal's fresh shell shows above its own output: the old screen as plain text, as
 * the Terminal tab last drew it (a full-screen program's last frame included), then the divider.
 * Plain text carries no sequence that could leave the new shell in the old program's modes. When
 * the emulator can't run, the raw tail stands in, followed by a reset of those modes.
 */
export const keptScreen = async (kept: KeptTerminal): Promise<string> => {
  let above: string;
  try {
    const { text } = await plainTail(
      kept.tail,
      KEPT_LINES,
      { cols: kept.cols, rows: kept.rows },
      kept.cut,
    );
    above = text === "" ? "" : `${text.replaceAll("\n", "\r\n")}\r\n`;
  } catch {
    const raw = kept.cut ? replayable(kept.tail) : kept.tail;
    above = `${raw}${RESET}\r\n`;
  }
  return `${above}\x1b[2m── ${KEPT_DIVIDER} ──\x1b[0m\r\n`;
};
