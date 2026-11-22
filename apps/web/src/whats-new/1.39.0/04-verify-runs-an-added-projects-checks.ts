import type { WhatsNewItem } from "../index";

export default {
  title: "Verify runs your project's own checks without asking",
  body: "In a project you added, verify now runs the checks the project declares on its default branch without asking first, each in a clean copy of its own. Checks changed only on a working branch still ask, and folders you haven't added run nothing.",
} satisfies WhatsNewItem;
