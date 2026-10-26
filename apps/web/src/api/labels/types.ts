import type { Label, LabelId } from "@gram/contracts";

/** `labels.*`: the user's thread labels (not a PR's GitHub labels). */
export interface LabelsApi {
  labels(): Promise<readonly Label[]>;
  upsertLabel(label: Label): Promise<Label>;
  /** Deletes the label; threads carrying it lose it. */
  removeLabel(labelId: LabelId): Promise<void>;
}
