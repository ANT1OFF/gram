import type { WhatsNewItem } from "../index";

export default {
  title: "Gram in a Linux container",
  body: "The repository now has a Docker image of Gram's server and web app, so agents can run on Linux under Docker Desktop on Windows or macOS. You build the image yourself, it listens on that machine's loopback only, and the Docker guide in the docs covers signing the agents in. Phone access, the tray and notifications don't apply in a container.",
} satisfies WhatsNewItem;
