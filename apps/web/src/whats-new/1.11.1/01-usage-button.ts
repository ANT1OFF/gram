import type { WhatsNewItem } from "../index";

export default {
  title: "Usage and Memory in the title bar",
  body: "The title bar's usage meter is a plain icon button again, so it no longer reads as a status line once a limit fills. Hover over it to see the limit it watches and how much is used, and click it for every agent's limits. A dot on its corner warns you: a ring when a limit passes 90%, amber when Gram is running on credits, and red when the limit is spent. In an orchestrator's title bar, Memory is back beside Chat and Board as a brain icon.",
} satisfies WhatsNewItem;
