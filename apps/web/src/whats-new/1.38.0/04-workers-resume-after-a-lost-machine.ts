import type { WhatsNewItem } from "../index";

export default {
  title: "Workers pick up again after a lost machine",
  body: "When a machine running a worker goes away and comes back, its folder is restored and its waiting messages and wakes are delivered. A session that can't start yet says why and tries again once the machine is ready.",
} satisfies WhatsNewItem;
