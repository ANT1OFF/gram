import type { Label, LabelId } from "@gram/contracts";

import type { MockWorld } from "../mock-world";
import type { LabelsApi } from "./types";

const SEED_LABELS: Label[] = [
  { id: "l-urgent" as LabelId, name: "urgent", color: "#f7768e" },
  { id: "l-review" as LabelId, name: "review", color: "#7aa2f7" },
];

/** `LabelsApi` over two seeded labels; removing one takes it off the threads carrying it. */
export function createLabelsMock(world: MockWorld): LabelsApi {
  let labels: Label[] = [...SEED_LABELS];
  return {
    labels: async () => labels,
    upsertLabel: async (label) => {
      const index = labels.findIndex((l) => l.id === label.id);
      labels = index === -1 ? [...labels, label] : labels.with(index, label);
      return label;
    },
    removeLabel: async (labelId) => {
      if (!labels.some((l) => l.id === labelId)) throw new Error(`NotFound: label ${labelId}`);
      labels = labels.filter((l) => l.id !== labelId);
      for (const { thread } of world.threads()) {
        if (thread.labels.includes(labelId)) world.updateThread(thread.id, { labels: [] });
      }
    },
  };
}
