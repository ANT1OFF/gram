import type {
  ShellCheck,
  TerminalEvent,
  TerminalId,
  TerminalInfo,
  TerminalOpened,
  ThreadId,
} from "@gram/contracts";

import { createChannel, type Channel } from "../channel";
import { MOCK_HOME } from "../mock-fs";
import type { MockWorld } from "../mock-world";
import { mockScript } from "../projects/mock-scripts";
import type { TerminalApi, TerminalOpenInput } from "./types";

const SCROLLBACK_LIMIT = 64_000;

interface MockTerminal {
  info: TerminalInfo;
  scrollback: string;
  line: string;
  subscribers: Set<Channel<TerminalEvent>>;
  exit?: { code?: number; signal?: string };
}

/** A project script's run: what the server resolves `terminal.open`'s `script` to. */
export interface MockScriptRun {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
}

const tagged = (tag: string, message: string) => Object.assign(new Error(message), { _tag: tag });

/** Fake PTYs for MockApi: a `$` prompt that echoes each entered line; `exit` ends the shell. */
export class MockTerminals {
  readonly #terminals = new Map<string, MockTerminal>();
  #seq = 0;

  open(input: TerminalOpenInput, defaultCwd: string, run?: MockScriptRun): TerminalOpened {
    const terminalId = `term-${++this.#seq}` as TerminalId;
    const cwd = run?.cwd ?? input.cwd ?? defaultCwd;
    const shell = input.shell ?? "/bin/zsh";
    this.#terminals.set(terminalId, {
      info: {
        terminalId,
        cwd,
        shell,
        alive: true,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(run === undefined ? {} : { script: run.name }),
      },
      scrollback:
        run === undefined
          ? `Gram mock shell in ${cwd}\r\n$ `
          : `\x1b[2m$ ${run.command}\x1b[0m\r\n`,
      line: "",
      subscribers: new Set(),
    });
    return { terminalId, cwd, shell, ...(run === undefined ? {} : { script: run.name }) };
  }

  /**
   * Plays a script's run: a few lines of output, then an exit with the code its command names
   * (`exit 2`, or `false` for 1), else 0.
   */
  async play(terminalId: TerminalId, run: MockScriptRun, delay: (ms: number) => Promise<void>) {
    const terminal = this.#terminals.get(terminalId);
    if (terminal === undefined) return;
    const code =
      /\bexit (\d+)/.exec(run.command)?.[1] ?? (/\bfalse\b/.test(run.command) ? "1" : "0");
    await delay(300);
    if (!terminal.info.alive) return;
    this.#write(terminal, `> ${run.name}\r\n> ${run.command}\r\n\r\n`);
    await delay(500);
    if (!terminal.info.alive) return;
    this.#write(
      terminal,
      code === "0"
        ? "\x1b[32m✓\x1b[0m 12 checks passed\r\n"
        : "\x1b[31m✗\x1b[0m 2 checks failed\r\n",
    );
    this.#exit(terminal, { code: Number(code) });
  }

  #get(terminalId: string): MockTerminal {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal) throw tagged("NotFound", `Terminal not found: ${terminalId}`);
    return terminal;
  }

  input(terminalId: string, data: string) {
    const terminal = this.#get(terminalId);
    if (!terminal.info.alive) throw tagged("InvalidState", "The shell has exited");
    let out = "";
    for (const ch of data) {
      if (ch === "\r") {
        const command = terminal.line.trim();
        terminal.line = "";
        out += "\r\n";
        if (command === "exit") {
          this.#write(terminal, out);
          this.#exit(terminal, { code: 0 });
          return;
        }
        out += `${command ? `echo: ${command}\r\n` : ""}$ `;
      } else if (ch === "") {
        if (terminal.line) {
          terminal.line = terminal.line.slice(0, -1);
          out += "\b \b";
        }
      } else if (ch >= " ") {
        terminal.line += ch;
        out += ch;
      }
    }
    if (out) this.#write(terminal, out);
  }

  resize(terminalId: string) {
    this.#get(terminalId);
  }

  close(terminalId: string) {
    const terminal = this.#get(terminalId);
    if (terminal.info.alive) this.#exit(terminal, { signal: "SIGHUP" });
    this.#terminals.delete(terminalId);
  }

  list(threadId?: ThreadId): TerminalInfo[] {
    return [...this.#terminals.values()]
      .map((t) => t.info)
      .filter((info) => threadId === undefined || info.threadId === threadId);
  }

  subscribe(terminalId: string, signal: AbortSignal): Channel<TerminalEvent> {
    const terminal = this.#get(terminalId);
    const channel = createChannel<TerminalEvent>(signal, () =>
      terminal.subscribers.delete(channel),
    );
    channel.push({ type: "replay", data: terminal.scrollback });
    if (terminal.info.alive) terminal.subscribers.add(channel);
    else {
      if (terminal.exit !== undefined) channel.push({ type: "exit", ...terminal.exit });
      channel.close();
    }
    return channel;
  }

  #write(terminal: MockTerminal, data: string) {
    terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT);
    for (const channel of terminal.subscribers) channel.push({ type: "data", data });
  }

  #exit(terminal: MockTerminal, how: { code?: number; signal?: string }) {
    terminal.info = {
      ...terminal.info,
      alive: false,
      ...(how.code === undefined ? {} : { exitCode: how.code }),
      ...(how.signal === undefined ? {} : { signal: how.signal }),
    };
    terminal.exit = how;
    for (const channel of terminal.subscribers) {
      channel.push({ type: "exit", ...how });
      channel.close();
    }
    terminal.subscribers.clear();
  }
}

/** `TerminalApi` over `MockTerminals`, opening in the thread's checkout or the mock's home. */
export function createTerminalMock(world: MockWorld): TerminalApi {
  const terminals = new MockTerminals();
  return {
    /** Profiles and paths are found unless they mention "missing". */
    terminalCheckShell: async (shell): Promise<ShellCheck> => {
      await world.delay(10);
      const value = shell.trim();
      if (value === "") return { found: false, message: "Enter a shell profile or a path." };
      if (/missing/i.test(value)) {
        return {
          found: false,
          message: `${value} doesn't exist. Choose an installed terminal shell in Settings.`,
        };
      }
      return { found: true, file: value };
    },
    terminalOpen: async ({ script, ...input }) => {
      const thread = input.threadId ? world.summary(input.threadId).thread : undefined;
      const cwd = thread?.checkout.path ?? MOCK_HOME;
      if (script === undefined) return terminals.open(input, cwd);
      const saved = thread === undefined ? undefined : mockScript(world, thread.projectId, script);
      if (saved === undefined) throw tagged("InvalidState", `There is no script named ${script}.`);
      const run = {
        name: saved.name,
        command: saved.command,
        cwd: saved.cwd === undefined ? cwd : `${cwd}/${saved.cwd}`,
      };
      const opened = terminals.open(input, cwd, run);
      void terminals.play(opened.terminalId, run, (ms) => world.delay(ms));
      return opened;
    },
    terminalInput: async (terminalId, data) => terminals.input(terminalId, data),
    terminalResize: async (terminalId) => terminals.resize(terminalId),
    terminalClose: async (terminalId) => terminals.close(terminalId),
    terminalList: async (threadId) => terminals.list(threadId),
    terminalFeed: (terminalId, signal) => terminals.subscribe(terminalId, signal),
  };
}
