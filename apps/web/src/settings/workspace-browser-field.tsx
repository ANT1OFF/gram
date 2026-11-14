import { browserAppProblem, browserSiteProblem, type OrchestratorCharter } from "@gram/contracts";
import { useId } from "react";

import { ConnectorEntries } from "./connector-entries";
import { Field } from "./fields";

/** `charter` with one of its browser lists replaced; an empty list leaves the key out. */
export const withBrowserList = (
  charter: OrchestratorCharter,
  key: "browserSites" | "browserApps",
  entries: readonly string[],
): OrchestratorCharter => {
  const { [key]: _was, ...rest } = charter;
  return entries.length === 0 ? rest : { ...rest, [key]: [...entries] };
};

/**
 * The charter's own limits on a lent browser: the sites and the Mac apps this workspace's
 * orchestrator and workers may act on, each in place of the user-wide list in Settings → Agents →
 * Your browser.
 */
export function WorkspaceBrowserFields({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  /** Saves the charter; settles once the server has it, and rejects with its refusal. */
  onChange: (next: OrchestratorCharter) => Promise<unknown>;
}) {
  const sitesId = useId();
  const appsId = useId();
  return (
    <>
      <Field
        label="Allowed sites"
        description="Limit a lent browser to these sites here. Empty follows Settings."
        learnMore={
          <p>
            List a site by its host alone (github.com), matched exactly. This workspace&apos;s list
            takes the place of the one under Settings → Agents → Your browser for its orchestrator
            and workers. A change applies from a thread&apos;s next session.
          </p>
        }
        keywords={["sites", "domains", "allowlist", "browser", "chrome"]}
        htmlFor={sitesId}
      >
        <ConnectorEntries
          id={sitesId}
          entries={charter.browserSites ?? []}
          disabled={disabled}
          onChange={(next) => onChange(withBrowserList(charter, "browserSites", next))}
          problemOf={browserSiteProblem}
          placeholder="example.com"
          emptyReason="Type a site first."
          testId="workspace-browser-sites"
        />
      </Field>
      <Field
        label="Allowed Mac apps"
        description="Limit Codex to these Mac apps here, each by its bundle id. Empty follows Settings."
        learnMore={
          <p>
            List an app by its bundle id (com.apple.Safari). This workspace&apos;s list takes the
            place of the one under Settings → Agents → Your browser. A change applies from a
            thread&apos;s next session.
          </p>
        }
        keywords={["apps", "mac", "bundle id", "allowlist", "codex", "computer use"]}
        htmlFor={appsId}
      >
        <ConnectorEntries
          id={appsId}
          entries={charter.browserApps ?? []}
          disabled={disabled}
          onChange={(next) => onChange(withBrowserList(charter, "browserApps", next))}
          problemOf={browserAppProblem}
          placeholder="com.example.App"
          emptyReason="Type a bundle id first."
          testId="workspace-browser-apps"
        />
      </Field>
    </>
  );
}
