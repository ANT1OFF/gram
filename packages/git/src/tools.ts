// Tool presence probes: whether `git`/`gh`/`claude` are installed and `gh` is logged in, with
// asymmetric TTLs — trust success long, retry failure fast, so `gh auth login` after launch works.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { gh } from "./exec.ts";
import { PathProbe, Proc } from "./proc.ts";

export interface ToolStatus {
  readonly git: boolean;
  readonly gh: boolean;
  readonly claude: boolean;
  /** `gh auth status` succeeded; tells "install gh" apart from "run `gh auth login`". */
  readonly ghAuthed: boolean;
}

/** Trust a positive probe for `positiveMs`, re-probe a negative one after `negativeMs`. */
export const cacheFresh = (
  at: number,
  value: boolean,
  now: number,
  positiveMs: number,
  negativeMs: number,
): boolean => now - at < (value ? positiveMs : negativeMs);

const isExecutableFile = (path: string, platform: NodeJS.Platform): boolean => {
  try {
    const stat = fs.statSync(path);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
};

/**
 * Where `bin` lives on `pathValue`, resolved like the shell would (PATHEXT on Windows, so npm's
 * `claude.cmd` counts as installed). `undefined` when absent.
 *
 * On Windows a name without an extension is only ever looked up with one, as `cmd.exe` does. npm
 * installs three shims side by side, `claude` (a `/bin/sh` script for Git Bash), `claude.cmd` and
 * `claude.ps1`, and the bare one can't be run: taking it left the launch checks of an npm-installed
 * Claude Code with no version and a sign-in they "couldn't tell" (0.2.0-rc.1).
 */
export const findOnPath = (
  bin: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathExt: string = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
  isExecutable: (path: string) => boolean = (path) => isExecutableFile(path, platform),
): string | undefined => {
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? nodePath.win32.join : nodePath.posix.join;
  const pathExts = pathExt.split(";").filter((e) => e !== "");
  const extensions =
    platform !== "win32" ? [""] : /\.[A-Za-z0-9]+$/.test(bin) ? ["", ...pathExts] : pathExts;
  for (const dir of pathValue.split(separator)) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = join(dir, bin + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
};

export class Tools extends Context.Service<
  Tools,
  {
    readonly present: (bin: string) => Effect.Effect<boolean>;
    readonly ghReady: Effect.Effect<boolean>;
    readonly check: Effect.Effect<ToolStatus>;
  }
>()("@gram/git/Tools") {}

const PRESENT_TTL_MS = 300_000;
const ABSENT_TTL_MS = 10_000;
const GH_READY_TTL_MS = 300_000;
const GH_NOT_READY_TTL_MS = 15_000;
const GH_AUTH_TIMEOUT_MS = 8_000;

export const ToolsLive = Layer.effect(
  Tools,
  Effect.gen(function* () {
    const probe = yield* PathProbe;
    const proc = yield* Proc;
    const presence = new Map<string, { at: number; value: boolean }>();
    let ghAuth: { at: number; value: boolean } | undefined;

    const present = (bin: string) =>
      Effect.gen(function* () {
        const cached = presence.get(bin);
        const now = Date.now();
        if (cached && cacheFresh(cached.at, cached.value, now, PRESENT_TTL_MS, ABSENT_TTL_MS)) {
          return cached.value;
        }
        const value = findOnPath(bin, yield* probe.path, process.platform) !== undefined;
        presence.set(bin, { at: Date.now(), value });
        return value;
      });

    const ghReady = Effect.gen(function* () {
      const now = Date.now();
      if (
        ghAuth &&
        cacheFresh(ghAuth.at, ghAuth.value, now, GH_READY_TTL_MS, GH_NOT_READY_TTL_MS)
      ) {
        return ghAuth.value;
      }
      const value = yield* gh(os.homedir(), ["auth", "status"], {
        timeoutMs: GH_AUTH_TIMEOUT_MS,
      }).pipe(
        Effect.map((out) => out.status === 0),
        Effect.orElseSucceed(() => false),
        Effect.provideService(Proc, proc),
      );
      ghAuth = { at: Date.now(), value };
      return value;
    });

    const check = Effect.gen(function* () {
      const ghAuthed = yield* ghReady;
      return {
        git: yield* present("git"),
        // An authed gh is obviously installed; skip the lookup.
        gh: ghAuthed || (yield* present("gh")),
        claude: yield* present("claude"),
        ghAuthed,
      } satisfies ToolStatus;
    });

    return { present, ghReady, check };
  }),
);
