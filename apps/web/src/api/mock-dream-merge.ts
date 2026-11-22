import type { DreamFileDiff } from "@gram/contracts";

/** A conflict's three sides, as one key: a merge asked of other sides no longer applies. */
export const sidesOf = (file: DreamFileDiff): string =>
  JSON.stringify([file.before ?? null, file.after ?? null, file.current ?? null]);

const linesOf = (text: string | undefined) => (text ?? "").replace(/\n$/, "").split("\n");

/** The mock's merge of a conflict: the update's version, with the lines only the current memory has. */
export const mockMerge = (file: Pick<DreamFileDiff, "before" | "after" | "current">): string => {
  const base = new Set(linesOf(file.before));
  const merged = linesOf(file.after);
  const current = linesOf(file.current);
  current.forEach((line, index) => {
    if (base.has(line) || merged.includes(line) || line.trim() === "") return;
    const after = index === 0 ? -1 : merged.indexOf(current[index - 1]!);
    if (after === -1) merged.push(line);
    else merged.splice(after + 1, 0, line);
  });
  return `${merged.join("\n")}\n`;
};
