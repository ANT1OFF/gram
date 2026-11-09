import type { WhatsNewItem } from "../index";

export default {
  title: "A timeline for each turn",
  body: "On a turn that used tools, the chart button beside its summary opens the Run timeline: each tool call is a bar on the turn's time axis with how long it took, so you can see where the time went and which calls ran side by side. Failed calls show in red, and turns from before this update have no timings.",
} satisfies WhatsNewItem;
