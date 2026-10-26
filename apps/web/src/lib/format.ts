const COUNT = new Intl.NumberFormat("en-US");

/**
 * `5624` as `5,624`. Pinned to en-US rather than the OS locale, so a count in English copy never
 * reads `5 624` (nb-NO) or `5.624` (de-DE).
 */
export const formatCount = (value: number): string => COUNT.format(value);

/**
 * The first line of `text`, cut to `max` characters, with an ellipsis wherever something was left
 * out, a later line included. For a command in a line or a tooltip: an agent's shell can be a
 * heredoc holding a whole file.
 */
export const firstLine = (text: string, max = 80): string => {
  const [head = "", ...rest] = text.trim().split(/\r?\n/);
  const line = head.trimEnd();
  if (line.length > max) return `${line.slice(0, max - 1).trimEnd()}…`;
  return rest.length > 0 ? `${line} …` : line;
};
