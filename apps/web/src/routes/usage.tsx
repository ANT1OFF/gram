import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "@/usage/usage-page";

export const Route = createFileRoute("/usage")({ component: UsagePage });
