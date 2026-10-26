/** What Settings search reads of one setting, block or section. */
export interface Searchable {
  readonly label: string;
  readonly description?: string | undefined;
  /** Words someone might type that the label and description don't contain. */
  readonly keywords?: readonly string[] | undefined;
  /** The heading it sits under, so "appearance font" finds the fonts. */
  readonly section?: string | undefined;
}

/** The query as lower-case words; none means no search is on. */
export const searchWords = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Whether `item` answers `query`: every word of the query appears somewhere in its label,
 * description, keywords or section name, in any order and ignoring case. An empty query matches
 * everything.
 */
export const matchesSearch = (query: string, item: Searchable): boolean => {
  const haystack = [item.label, item.description, item.section, ...(item.keywords ?? [])]
    .filter((text) => text !== undefined)
    .join("\n")
    .toLowerCase();
  return searchWords(query).every((word) => haystack.includes(word));
};
