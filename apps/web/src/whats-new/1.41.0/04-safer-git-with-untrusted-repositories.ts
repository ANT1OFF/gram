import type { WhatsNewItem } from "../index";

export default {
  title: "Safer git with branch and remote names you didn't choose",
  body: "Gram no longer lets a repository's branch, remote or base name be read by git as an option, and a push that rewrites remote history is now asked about as a force push. Gram now needs Git 2.31 or newer and says so if yours is older.",
} satisfies WhatsNewItem;
