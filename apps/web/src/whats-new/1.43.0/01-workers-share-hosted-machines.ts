import type { WhatsNewItem } from "../index";

export default {
  title: "Workers can share a hosted machine",
  body: "With the hosted features on, an orchestrator can give a worker a hosted machine of its own or put several of its workers on one, which start in seconds. A workspace's settings choose the default under Workers run on (Its machine, Shared or One each) and cap it with Workers per machine; a machine is released once every worker on it is finished.",
} satisfies WhatsNewItem;
