import { createFileRoute } from "@tanstack/react-router";

import { PhoneAccessPage } from "@/settings/phone-access-page";

export const Route = createFileRoute("/settings/phones")({
  component: PhoneAccessPage,
});
