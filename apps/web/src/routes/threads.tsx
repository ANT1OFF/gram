import { createFileRoute } from "@tanstack/react-router";

import { ThreadsPage } from "@/threads/threads-page";

export const Route = createFileRoute("/threads")({ component: ThreadsPage });
