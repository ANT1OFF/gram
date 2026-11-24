import type { WhatsNewItem } from "../index";

export default {
  title: "Stopped machines start before the work arrives",
  body: "A stopped worker machine is started shortly before a scheduled wake is due, or when you start typing in its thread, so the turn begins sooner. A newly joined machine also starts its first turn without waiting for the whole shared folder to copy over.",
} satisfies WhatsNewItem;
