import type { WhatsNewItem } from "../index";

export default {
  title: "A calmer sidebar",
  body: "Sidebar titles stay on one line, with the whole title on hover, and a worker's agent mark shows only when its workspace's workers run different agents. Workspaces with nothing running or asking fold into one Idle row at the end of the list, and come back out as soon as something starts. On the compact rail each workspace tile shows a monogram of its name, with the full name on hover. Amber now means only that something needs you: progress bars are grey, a failing pull request chip is outlined rather than filled, and buttons no longer carry a glyph that repeats their words. History has one way in, at the foot of the sidebar.",
} satisfies WhatsNewItem;
