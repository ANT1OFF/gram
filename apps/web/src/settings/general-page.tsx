// One of the Settings pages built from several sections, apart from the page list (`pages.tsx`) so
// that the list, which the nav and every Settings route load, does not bring the sections with it.

import { AgentBrowseSection } from "./agent-browse-section";
import { EditorSection } from "./editor-section";
import { GENERAL_ANCHORS } from "./general-anchors";
import { GeneralSection } from "./general-section";
import { SearchScope } from "./search-scope";
import { SettingsGroup } from "./settings-group";
import { TrustedLinksSection } from "./trusted-links-section";
import { useFeature } from "./use-diagnostics";

/**
 * Search words for the parts of a page that aren't built from `Field`s, which bring their own label
 * and description. Words the heading already has don't need repeating.
 */
const EDITOR_KEYWORDS = ["vs code", "vscode", "cursor", "zed", "command", "path", "line"];
const TRUSTED_LINK_KEYWORDS = ["link", "domain", "host", "url", "browser", "open external"];
const AGENT_BROWSE_KEYWORDS = ["browse", "browser", "preview", "host", "site", "domain", "agent"];

/**
 * Settings → General: new-thread defaults, layout, the editor files open in, trusted links and the
 * hosts agents may browse.
 */
export function GeneralPage() {
  const agentBrowsing = useFeature("agentBrowsingPublic", { settled: true });
  return (
    <>
      <SearchScope label="General">
        <GeneralSection />
      </SearchScope>
      <SettingsGroup
        label="Open in editor"
        anchor={GENERAL_ANCHORS.editor}
        description="The editor Open in editor launches: a preset, or your own command."
        keywords={EDITOR_KEYWORDS}
      >
        <EditorSection />
      </SettingsGroup>
      <SettingsGroup
        label="Trusted links"
        anchor={GENERAL_ANCHORS.links}
        card={false}
        description="Links to these hosts open in your browser without asking."
        learnMore={
          <p>
            Tick &ldquo;Always open links to…&rdquo; in the link dialog to add one. Only https links
            on the usual port skip the question; anything else, or a link with a user name before
            the host, still asks.
          </p>
        }
        keywords={TRUSTED_LINK_KEYWORDS}
      >
        <TrustedLinksSection />
      </SettingsGroup>
      {agentBrowsing && (
        <SettingsGroup
          label="Agent may browse"
          card={false}
          description="Public sites agents may open in the Preview pane without asking."
          learnMore={
            <p>
              Trusted links count too. &ldquo;Always for this host&rdquo; on an agent&rsquo;s
              request adds one. Submitting a form still asks every time; private-network and sign-in
              pages are restricted.
            </p>
          }
          keywords={AGENT_BROWSE_KEYWORDS}
        >
          <AgentBrowseSection />
        </SettingsGroup>
      )}
    </>
  );
}
