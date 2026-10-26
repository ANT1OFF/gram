// Suggested replies as the helper writes them, and the checks one must pass before a user sees it.
// The recap's first suggestions and the turn-end ones share both.

/** At most this many suggestions, most likely first. */
export const MAX_REPLIES = 3;
/** A longer suggestion is dropped, never cut: the 2026-09-20 experiments found them wordy. */
const REPLY_MAX_CHARS = 90;
const REPLY_MAX_WORDS = 12;

/** The rules both prompts give the model for a suggestion. */
export const REPLY_RULES = [
  "- 0 to 3 replies, most likely first. An empty list is right when there is no obvious next message.",
  '- Each at most 12 words, one line, in the user\'s own voice: imperative, no greeting, no "please" unless they use it, no questions back unless the agent asked the user to choose; then the replies are the choices.',
  "- Only name files, commands or PRs that appear in the material.",
  '- Never write as the agent ("I\'ll…", "Let me…").',
].join("\n");

/** The agent's voice, which a message from the user never opens with. */
const AGENT_VOICE = /^(I('ll| will| can)|Let me|Sure|Okay)\b/i;

/** Something the model could only have got right by reading it: a `backticked` token or a path. */
const specifics = (reply: string): ReadonlyArray<string> => [
  ...[...reply.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
  ...[
    ...reply.matchAll(
      /(?:^|\s)([\w.@-]*\/[\w./@-]+|[A-Za-z_][\w-]*\.[A-Za-z]{1,5})(?=[\s,;:!?)]|\.?$)/g,
    ),
  ].map((m) => m[1]!),
];

const normal = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

export interface ReplyContext {
  /** Everything the prompt showed the model: a named file or command must appear in it. */
  readonly material: string;
  /** The user's last message; a suggestion that repeats it is no suggestion. */
  readonly lastUserMessage?: string | undefined;
}

/**
 * The suggestions worth showing, in the model's order: one line, at most `REPLY_MAX_WORDS` words and
 * `REPLY_MAX_CHARS` characters, not in the agent's voice, naming nothing the material doesn't, and
 * neither a repeat of another nor of the user's last message. At most `MAX_REPLIES`.
 */
export const validReplies = (
  replies: ReadonlyArray<unknown>,
  { material, lastUserMessage }: ReplyContext,
): string[] => {
  const seen = new Set<string>(lastUserMessage === undefined ? [] : [normal(lastUserMessage)]);
  const kept: string[] = [];
  for (const raw of replies) {
    if (typeof raw !== "string") continue;
    const reply = raw
      .trim()
      .replace(/^["“]|["”]$/g, "")
      .trim();
    if (reply === "" || /[\r\n]/.test(reply) || reply.length > REPLY_MAX_CHARS) continue;
    if (reply.split(/\s+/).length > REPLY_MAX_WORDS || AGENT_VOICE.test(reply)) continue;
    if (specifics(reply).some((token) => !material.includes(token))) continue;
    const key = normal(reply);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(reply);
    if (kept.length === MAX_REPLIES) break;
  }
  return kept;
};
