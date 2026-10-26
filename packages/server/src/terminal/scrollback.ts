/** Default scrollback kept per terminal and replayed on subscribe, in UTF-16 code units. */
export const SCROLLBACK_LIMIT = 256 * 1024;

/** The private modes that switch to the alternate screen, in the three spellings programs use. */
const ALT_MODES = ["1049", "1047", "47"] as const;

/** Where the first sequence setting (`h`) or resetting (`l`) an alternate-screen mode is, and its length. */
const firstAltSwitch = (
  text: string,
  final: "h" | "l",
): { readonly index: number; readonly length: number } | undefined => {
  let first: { index: number; length: number } | undefined;
  for (const mode of ALT_MODES) {
    const sequence = `\x1b[?${mode}${final}`;
    const index = text.indexOf(sequence);
    if (index !== -1 && (first === undefined || index < first.index)) {
      first = { index, length: sequence.length };
    }
  }
  return first;
};

/**
 * A capped tail made safe to replay into a blank emulator, the Terminal tab's or `read_terminal`'s. Two things the dropped prefix can take
 * with it would otherwise put text on screen that no terminal ever showed:
 *
 * - the opening of an escape sequence, leaving its payload (a window title, a hyperlink target) to
 *   be read as output. The tail is started at its first line break, which no sequence spans.
 * - the *entry* to the alternate screen, when a full-screen program wrote more than the cap and then
 *   quit. Its frames would be replayed onto the normal screen. Everything up to that unmatched exit
 *   was alternate-screen content the real terminal threw away on exit, so it is dropped here too.
 */
export const replayable = (raw: string): string => {
  const lineBreak = raw.indexOf("\n");
  let tail = lineBreak === -1 ? "" : raw.slice(lineBreak + 1);
  const exit = firstAltSwitch(tail, "l");
  const enter = firstAltSwitch(tail, "h");
  if (exit !== undefined && (enter === undefined || exit.index < enter.index)) {
    tail = tail.slice(exit.index + exit.length);
  }
  return tail;
};

/**
 * The capped tail of a terminal's output. Old chunks are dropped whole; a single chunk larger than
 * the cap keeps only its tail.
 */
export class Scrollback {
  readonly #limit: number;
  readonly #chunks: Array<string> = [];
  #size = 0;
  #cut = false;

  constructor(limit: number = SCROLLBACK_LIMIT) {
    this.#limit = limit;
  }

  append(data: string): void {
    if (data.length >= this.#limit) {
      this.#cut = this.#cut || this.#size > 0 || data.length > this.#limit;
      this.#chunks.length = 0;
      this.#chunks.push(data.slice(data.length - this.#limit));
      this.#size = this.#limit;
      return;
    }
    this.#chunks.push(data);
    this.#size += data.length;
    if (this.#size > this.#limit) this.#cut = true;
    while (this.#size > this.#limit) {
      const head = this.#chunks[0] ?? "";
      const excess = this.#size - this.#limit;
      if (head.length <= excess) {
        this.#chunks.shift();
        this.#size -= head.length;
      } else {
        this.#chunks[0] = head.slice(excess);
        this.#size -= excess;
      }
    }
  }

  get size(): number {
    return this.#size;
  }

  /** Whether output has been dropped from the front, so what is kept may open mid-line or mid-sequence. */
  get cut(): boolean {
    return this.#cut;
  }

  toString(): string {
    return this.#chunks.join("");
  }

  /**
   * What to write into a blank emulator to show this terminal: everything kept, made `replayable`
   * once the front has been dropped. Every consumer replays this and nothing else, so the Terminal
   * tab and `read_terminal` reconstruct the same screen.
   */
  toReplay(): string {
    return this.#cut ? replayable(this.toString()) : this.toString();
  }
}
