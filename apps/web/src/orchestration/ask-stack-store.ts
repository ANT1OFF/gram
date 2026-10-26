import { create } from "zustand";

// Answers from the ask stack wait `UNDO_MS` before they go out, so one key can be taken back. Kept
// outside React: moving to another thread doesn't cancel an answer, and coming back finds it. What
// an answer hides is its requests' ids (or a question's), never an ask's key: a group that gains or
// loses a member meanwhile keeps the answered ones out.

/** How long an answer can be taken back. */
export const UNDO_MS = 4_000;
/** How long a sent answer's requests stay hidden while the server's word that they're gone arrives. */
export const SENT_GRACE_MS = 10_000;

interface HeldAnswer {
  /** The ask's key when it was answered. */
  readonly key: string;
  /** The requests (or question) it answers. */
  readonly ids: readonly string[];
  /** What the undo line says: "Allowed 3". */
  readonly done: string;
}

/** What a send reports: the ids it didn't answer, which come back with `problem` beside them. */
export interface SendResult {
  readonly failed?: readonly string[] | undefined;
  readonly problem?: string | undefined;
}

interface AskStackState {
  /** Answers not sent yet, oldest first: the only ones Undo can take back. */
  readonly held: readonly HeldAnswer[];
  /** Ids being sent or sent a moment ago, hidden until the server says they're gone. */
  readonly sent: Readonly<Record<string, true>>;
  /** What went wrong with an id's last answer. */
  readonly problems: Readonly<Record<string, string>>;
  /** A free-form reply typed and not sent, by its ask's first id. */
  readonly replies: Readonly<Record<string, string>>;
  /** The ask a notification's Open asked to show, by key, until a stack showing it takes it. */
  readonly focusKey: string | undefined;
  /** Holds `send` for `UNDO_MS`, then runs it. */
  readonly hold: (answer: HeldAnswer, send: () => Promise<SendResult>) => void;
  /** Takes back `key`'s held answer, or the newest; `undefined` when none is held any more. */
  readonly undo: (key?: string) => HeldAnswer | undefined;
  readonly setReply: (id: string, text: string) => void;
  readonly focus: (key: string | undefined) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const without = <V>(record: Readonly<Record<string, V>>, ids: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)));

export const useAskStackStore = create<AskStackState>()((set, get) => ({
  held: [],
  sent: {},
  problems: {},
  replies: {},
  focusKey: undefined,
  hold: (answer, send) => {
    if (timers.has(answer.key)) return;
    set((s) => ({
      held: [...s.held, answer],
      problems: without(s.problems, answer.ids),
    }));
    timers.set(
      answer.key,
      setTimeout(() => {
        timers.delete(answer.key);
        // In flight from here: off the undo line, and still hidden.
        set((s) => ({
          held: s.held.filter((h) => h.key !== answer.key),
          sent: { ...s.sent, ...Object.fromEntries(answer.ids.map((id) => [id, true as const])) },
          replies: without(s.replies, answer.ids),
        }));
        const settle = ({ failed = [], problem }: SendResult) => {
          set((s) => ({
            sent: without(s.sent, failed),
            problems:
              problem === undefined
                ? s.problems
                : { ...s.problems, ...Object.fromEntries(failed.map((id) => [id, problem])) },
          }));
          const answered = answer.ids.filter((id) => !failed.includes(id));
          setTimeout(() => set((s) => ({ sent: without(s.sent, answered) })), SENT_GRACE_MS);
        };
        void send().then(settle, (error: unknown) =>
          settle({
            failed: answer.ids,
            problem: error instanceof Error ? error.message : String(error),
          }),
        );
      }, UNDO_MS),
    );
  },
  undo: (key) => {
    const target = key === undefined ? get().held.at(-1) : get().held.find((h) => h.key === key);
    if (target === undefined || !timers.has(target.key)) return undefined;
    clearTimeout(timers.get(target.key));
    timers.delete(target.key);
    set((s) => ({ held: s.held.filter((h) => h.key !== target.key) }));
    return target;
  },
  setReply: (id, text) => set((s) => ({ replies: { ...s.replies, [id]: text } })),
  focus: (focusKey) => set({ focusKey }),
}));

/** Every id an answer from here hides: held, being sent, or sent a moment ago. */
export const hiddenIds = (state: Pick<AskStackState, "held" | "sent">): ReadonlySet<string> =>
  new Set([...state.held.flatMap((h) => h.ids), ...Object.keys(state.sent)]);
