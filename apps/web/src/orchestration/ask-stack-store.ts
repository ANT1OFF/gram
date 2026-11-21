import { create } from "zustand";

/** How long an answer can be taken back. */
export const UNDO_MS = 4_000;
/** How long a sent answer's requests stay hidden while the server's word that they're gone arrives. */
export const SENT_GRACE_MS = 10_000;

interface HeldAnswer {
  readonly key: string;
  readonly ids: readonly string[];
  readonly done: string;
}

/** What a send reports: the ids it didn't answer, which come back with `problem` beside them. */
export interface SendResult {
  readonly failed?: readonly string[] | undefined;
  readonly problem?: string | undefined;
}

interface AskStackState {
  readonly held: readonly HeldAnswer[];
  readonly sent: Readonly<Record<string, true>>;
  readonly problems: Readonly<Record<string, string>>;
  readonly replies: Readonly<Record<string, string>>;
  readonly hold: (answer: HeldAnswer, send: () => Promise<SendResult>) => void;
  readonly undo: (key?: string) => HeldAnswer | undefined;
  readonly setReply: (id: string, text: string) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const without = <V>(record: Readonly<Record<string, V>>, ids: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)));

export const useAskStackStore = create<AskStackState>()((set, get) => ({
  held: [],
  sent: {},
  problems: {},
  replies: {},
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
}));

/** Every id an answer from here hides: held, being sent, or sent a moment ago. */
export const hiddenIds = (state: Pick<AskStackState, "held" | "sent">): ReadonlySet<string> =>
  new Set([...state.held.flatMap((h) => h.ids), ...Object.keys(state.sent)]);

/** Which of `requests` an answer from here hides, by id: what their cards leave out. */
export const answeredAmong = (
  state: Pick<AskStackState, "held" | "sent">,
  requests: readonly { readonly id: string }[],
): readonly string[] => {
  if (requests.length === 0 || (state.held.length === 0 && Object.keys(state.sent).length === 0)) {
    return NONE;
  }
  const hidden = hiddenIds(state);
  return requests.flatMap((request) => (hidden.has(request.id) ? [request.id] : []));
};

const NONE: readonly string[] = [];
