import { errnoCode, fieldsOf } from "@gram/contracts";
import { copyFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { MachineMarks, type MachineMarksByHost } from "./stop-marks.ts";
import * as Predicate from "effect/Predicate";

/** A store, made on first write: a Gram no machine joined never makes the file or its folder. */
export const lazyFileStore = <R, W>(
  dataDir: string,
  name: string,
  make: (dataDir: string) => { readonly read: () => R; readonly write: (value: W) => void },
  empty: () => R,
  otherFilesItKeeps: ReadonlyArray<string> = [],
) => {
  let store: ReturnType<typeof make> | undefined;
  const real = () => (store ??= make(dataDir));
  return {
    read: (): R =>
      store === undefined &&
      ![name, ...otherFilesItKeeps].some((file) => existsSync(join(dataDir, "remote-access", file)))
        ? empty()
        : real().read(),
    write: (value: W) => real().write(value),
  };
};

/** The automatic-updates switch, as kept: undefined until it is first set. */
export interface AutomaticStore {
  readonly read: () => boolean | undefined;
  readonly write: (on: boolean) => void;
}

/**
 * The switch in `remote-access/machine-updates.json`, owner-only like the machines beside it. Only
 * a file that is genuinely not there reads as never set (on): anything else that stops it being
 * read (a folder it can't look into, a link, a file not its own or not a switch) throws, and
 * `automaticUpdates` reads that as off. Never `existsSync`, which says "absent" for all of those.
 */
export const fileAutomaticStore = (dataDir: string): AutomaticStore => {
  const name = "machine-updates.json";
  const file = () => privateJsonFile(dataDir, name, 1024);
  return {
    read: () => {
      for (const [path, folder] of [
        [join(dataDir, "remote-access"), true],
        [join(dataDir, "remote-access", name), false],
      ] as const) {
        let stat;
        try {
          stat = lstatSync(path);
        } catch (error) {
          if (errnoCode(error) === "ENOENT") return undefined;
          throw error;
        }
        if (folder ? !stat.isDirectory() : !stat.isFile())
          throw new Error(`${path} isn't a ${folder ? "folder" : "file"} of its own.`);
      }
      const read: unknown = file().read();
      if (read === undefined) throw new Error(`${name} went away while it was read.`);
      const value = fieldsOf(read);
      const automatic = value.get("automatic");
      if (value.get("version") !== 1 || typeof automatic !== "boolean")
        throw new Error(`${name} isn't a machine updates file.`);
      return automatic;
    },
    write: (on) => file().write({ version: 1, automatic: on }),
  };
};

/** The machines' stop marks and disks (`stop-marks.ts`), as kept across a restart. */
export interface MarksStore {
  /**
   * Every machine's marks, and how many machines' marks were left out for not reading as marks;
   * throws when what is kept can't be read at all.
   */
  readonly read: () => {
    readonly machines: MachineMarksByHost;
    readonly dropped: ReadonlyArray<string>;
  };
  /** Keeps a copy of what can't be read aside, for a person to look at. */
  readonly quarantine?: () => void;
  /** Throws when they couldn't be kept. */
  readonly write: (all: MachineMarksByHost) => void;
}

const MARKS_FILE_MOST_BYTES = 4 * 1024 * 1024;

/**
 * The marks in `remote-access/machine-marks.json`, owner-only beside the machines, each write a
 * whole new file renamed over the old (`privateJsonFile`). A machine whose marks don't read as
 * marks is left out, so one bad entry costs only its own; a file that isn't marks at all throws.
 * A write that would come to more than is read back leaves out what stops kept of folders, which
 * only holds a resume to a commit, before the disks and what is owed; past that it throws.
 */
export const fileMarksStore = (dataDir: string): MarksStore => {
  const file = privateJsonFile(dataDir, "machine-marks.json", MARKS_FILE_MOST_BYTES);
  const decode = Schema.decodeUnknownOption(MachineMarks);
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MARKS_FILE_MOST_BYTES;
  return {
    read: () => {
      const value: unknown = file.read();
      if (value === undefined) return { machines: {}, dropped: [] };
      const kept = Predicate.isObject(value) ? value["machines"] : undefined;
      if (!Predicate.isObject(value) || value["version"] !== 1 || !Predicate.isObject(kept))
        throw new Error("machine-marks.json isn't a machine marks file.");
      const machines: Record<string, MachineMarks> = {};
      const dropped: Array<string> = [];
      for (const [id, marks] of Object.entries(kept)) {
        const decoded = decode(marks);
        if (decoded._tag === "Some") machines[id] = decoded.value;
        else dropped.push(id);
      }
      return { machines, dropped };
    },
    quarantine: () => {
      const path = join(dataDir, "remote-access", "machine-marks.json");
      try {
        copyFileSync(path, `${path}.unreadable-${Date.now()}`);
      } catch {
        return;
      }
    },
    write: (all) => {
      const whole = { version: 1, machines: all };
      if (fits(whole)) return file.write(whole);
      const lean = {
        version: 1,
        machines: Object.fromEntries(
          Object.entries(all).map(([id, marks]) => {
            const { kept: _, rested: __, back: ___, ...rest } = marks;
            return [id, rest];
          }),
        ),
      };
      if (!fits(lean)) throw new Error("The machines' marks don't fit in machine-marks.json.");
      file.write(lean);
    },
  };
};
