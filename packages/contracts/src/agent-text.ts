/** How long a quoted title runs on a server-written line. */
export const TITLE_MAX = 80;

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** Characters that show nothing but can split a tag name or hide a turn of the text. */
export const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Worker-influenced text on a server-authored line: one line, clipped, unable to open a tag or to
 * close the quotes a server line puts round it, whichever quote marks those are.
 */
export const inline = (text: string, max = TITLE_MAX): string =>
  clip(
    text
      .replaceAll(INVISIBLE, "")
      .replaceAll(/\s+/g, " ")
      .trim()
      .replaceAll(/[<\uFF1C]/g, "‹")
      .replaceAll(/[>\uFF1E]/g, "›")
      .replaceAll(/["\u201C-\u201F\u00AB\u00BB\uFF02]/g, "'"),
    max,
  );

/** {@link inline}, for a server-written note or notice built outside this file. */
export const inlineText = (text: string, max = TITLE_MAX): string => inline(text, max);

/** Longest title an agent may give its own thread (`set_title`). */
export const AGENT_TITLE_MAX = 120;

/**
 * A title an agent gives its own thread: one line, nothing invisible or a control character, at
 * most {@link AGENT_TITLE_MAX} characters. Every place that shows or quotes it gets a plain value,
 * even one that forgets to encode it.
 */
export const agentTitle = (text: string): string =>
  clip(
    text
      .replaceAll(INVISIBLE, "")
      // oxlint-disable-next-line no-control-regex -- control characters are what this removes
      .replaceAll(/[\s\u0000-\u001F\u007F-\u009F]+/g, " ")
      .trim(),
    AGENT_TITLE_MAX,
  );

/**
 * Worker-authored text inside a block. Only the block's own tag is defused, so a contract full of
 * generics stays readable while `</worker-report>` in a summary cannot end the block early.
 */
export const quoted = (text: string, max: number): string => defuseTags(clip(text, max));

/**
 * Every tag Gram fences another agent's words in, defused in such words so they can neither close
 * their own block early nor open one that passes for another kind.
 */
export const defuseTags = (text: string): string =>
  text
    .replaceAll(INVISIBLE, "")
    .replaceAll(
      /[<\uFF1C](?=(?:\s*[/\uFF0F])?\s*(?:worker[-\u2010-\u2015\u2212](?:report|question|message)|thread[-\u2010-\u2015\u2212]message)\b)/gi,
      "‹",
    );
