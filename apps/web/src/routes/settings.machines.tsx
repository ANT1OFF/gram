import { createFileRoute } from "@tanstack/react-router";

import { HostedDeviceSection } from "@/settings/hosted-device-section";
import { MachinesPage } from "@/settings/machines-page";

/**
 * Settings → Machines: the other machines joined to this Gram, lending this one to hosted
 * workspaces while hosted features are on, then its pages.
 */
export const Route = createFileRoute("/settings/machines")({
  component: () => (
    <div className="flex flex-col gap-6">
      <MachinesPage />
      <HostedDeviceSection />
    </div>
  ),
});
