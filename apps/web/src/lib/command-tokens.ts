import type { ThemedToken } from "shiki";

import type { TokenizedCode } from "@/lib/code-highlighting";
import type { EmbeddedScript } from "@/lib/embedded-scripts";

const separatorsOf = (text: string) => text.match(/\r?\n/gu) ?? [];

function placed(text: string, tokenized: TokenizedCode) {
  const separators = separatorsOf(text);
  if (tokenized.tokens.length !== separators.length + 1) return undefined;
  const out: { token: ThemedToken; offset: number }[] = [];
  let offset = 0;
  for (const [index, line] of tokenized.tokens.entries()) {
    if (index > 0) offset += separators[index - 1]!.length;
    for (const token of line) {
      if (text.slice(offset, offset + token.content.length) !== token.content) return undefined;
      out.push({ token, offset });
      offset += token.content.length;
    }
  }
  return offset === text.length ? out : undefined;
}

const colourless = (token: ThemedToken) =>
  (token.color === undefined || token.color === "inherit") && token.htmlStyle === undefined;

const styleKey = (token: ThemedToken | undefined) =>
  token === undefined
    ? ""
    : `${token.color ?? ""}|${token.fontStyle ?? ""}|${token.bgColor ?? ""}|${JSON.stringify(token.htmlStyle ?? {})}`;

/**
 * The command's own tokens with each embedded script's tokens painted over the characters that
 * spell it, inner scripts last. The text is exactly `code`; only colours change.
 */
export function paintEmbedded(
  code: string,
  outer: TokenizedCode,
  layers: readonly { script: EmbeddedScript; tokens: TokenizedCode }[],
): TokenizedCode {
  const base = placed(code, outer);
  if (!base || layers.length === 0) return outer;
  const styles = Array.from<ThemedToken | undefined>({ length: code.length });
  for (const { token, offset } of base) styles.fill(token, offset, offset + token.content.length);
  let painted = false;
  for (const { script, tokens } of layers) {
    const inner = placed(script.text, tokens);
    if (!inner) continue;
    for (const { token, offset } of inner) {
      if (colourless(token)) continue;
      for (let index = offset; index < offset + token.content.length; index += 1) {
        if (script.text[index] === "\n" || script.text[index] === "\r") continue;
        styles.fill(token, script.starts[index], script.ends[index]);
        painted = true;
      }
    }
  }
  if (!painted) return outer;

  const lines: ThemedToken[][] = [];
  let start = 0;
  for (const separator of [...code.matchAll(/\r?\n/gu), undefined]) {
    const end = separator?.index ?? code.length;
    const line: ThemedToken[] = [];
    let index = start;
    while (index < end) {
      const style = styles[index];
      const key = styleKey(style);
      let next = index + 1;
      while (next < end && styleKey(styles[next]) === key) next += 1;
      line.push({
        ...(style ?? { color: "inherit" }),
        content: code.slice(index, next),
        offset: index,
      });
      index = next;
    }
    lines.push(line);
    if (separator) start = separator.index + separator[0].length;
  }
  return { tokens: lines, fg: outer.fg, bg: outer.bg };
}
