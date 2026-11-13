// One of the Settings pages built from several sections, apart from the page list (`pages.tsx`) so
// that the list, which the nav and every Settings route load, does not bring the sections with it.

import { AgentChecks } from "@/launch-checks/tool-checks";

import { AgentsSection } from "./agents-section";
import { YourBrowserSection } from "./browser-section";
import { CustomModelsSection } from "./custom-models-section";
import { SettingsGroup } from "./settings-group";

const CUSTOM_MODEL_KEYWORDS = ["model id", "reasoning effort"];

/** Settings → Agents: each agent's status, new-thread defaults, custom models. */
export function AgentsPage() {
  return (
    <>
      <AgentChecks />
      <AgentsSection />
      <YourBrowserSection />
      <SettingsGroup
        label="Custom models"
        card={false}
        description={
          <>
            Models an agent doesn&apos;t list itself, such as{" "}
            <code className="font-mono">opus[1m]</code>. Pickers offer them after its own.
          </>
        }
        learnMore={
          <p>
            The id is sent to the agent as written. Context size and cost are whatever the agent
            reports once the thread runs.
          </p>
        }
        keywords={CUSTOM_MODEL_KEYWORDS}
      >
        <CustomModelsSection />
      </SettingsGroup>
    </>
  );
}
