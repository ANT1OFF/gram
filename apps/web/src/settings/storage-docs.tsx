import {
  DOCS_ARCHIVE_KEEP_MAX,
  DOCS_ARCHIVE_KEEP_MIN,
  docsArchiveOf,
  type SettingsPatch,
} from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import { NumberField, OptionGroup } from "./fields";
import { SettingDescription } from "./help-tip";
import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

/**
 * The Storage page's Docs card: "Archive docs older than…" across every workspace, and when docs
 * archive themselves (a PR's doc after it merges, a worker's after it is archived) and how many
 * archived docs are kept.
 */
export function DocsStorage() {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="storage-docs">
      <h3 id="storage-docs" className={`px-1 ${GROUP_TITLE}`}>
        Docs
      </h3>
      <div className={SETTINGS_CARD}>
        <ArchiveOldDocs />
        <DocsAutoArchive />
      </div>
    </section>
  );
}

const ARCHIVE_OLDER_DAYS = [7, 14, 30, 90] as const;

function ArchiveOldDocs() {
  const api = useApi();
  const [days, setDays] = useState<string>(String(ARCHIVE_OLDER_DAYS[2]));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean }>();
  const archive = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const archived = await api.archiveDocsOlderThan(Number(days));
      setResult({
        text:
          archived === 0
            ? "No docs were that old."
            : `Archived ${archived} doc${archived === 1 ? "" : "s"}. Restore any from the Docs tab.`,
        failed: false,
      });
    } catch (e) {
      setResult({ text: errorMessage(e), failed: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span className="font-medium">Archive docs older than</span>
          <span className="text-meta text-muted-foreground">
            Every workspace's docs you haven't opened or saved since, the orchestrator's included.
          </span>
        </div>
        <OptionGroup
          label="Older than"
          options={ARCHIVE_OLDER_DAYS.map((n) => ({ value: String(n), label: `${n} days` }))}
          value={days}
          onChange={setDays}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="storage-archive-docs"
          disabled={busy}
          onClick={() => void archive()}
        >
          Archive
        </Button>
      </div>
      {result !== undefined && (
        <p
          role={result.failed ? "alert" : "status"}
          className={cn("text-meta", result.failed ? "text-destructive" : "text-muted-foreground")}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}

function DocsAutoArchive() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [error, setError] = useState<string>();
  if (settings === undefined) return null;
  const policy = docsArchiveOf(settings);
  const saveDocs = (patch: NonNullable<SettingsPatch["workspaces"]>) => {
    setError(undefined);
    save({ workspaces: patch }).catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <div className="flex flex-col gap-2 py-3">
      <SettingDescription>
        Never the orchestrator's docs, or one you opened or saved in the last 14 days.
      </SettingDescription>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <NumberField
          label="PR docs after (days)"
          description="Archive a PR's doc once it merged or closed this long ago."
          keywords={["review", "docs", "archive"]}
          value={policy.prDays}
          min={1}
          onCommit={(docsArchivePrDays) => saveDocs({ docsArchivePrDays })}
        />
        <NumberField
          label="Worker docs after (days)"
          description="Archive a worker's other docs once it was archived this long ago."
          keywords={["docs", "archive"]}
          value={policy.workerDays}
          min={1}
          onCommit={(docsArchiveWorkerDays) => saveDocs({ docsArchiveWorkerDays })}
        />
        <NumberField
          label="Keep archived docs"
          description="Past this, the earliest archived are deleted."
          keywords={["docs", "archive", "delete"]}
          value={policy.keep}
          min={DOCS_ARCHIVE_KEEP_MIN}
          onCommit={(keep) => saveDocs({ docsArchiveKeep: Math.min(keep, DOCS_ARCHIVE_KEEP_MAX) })}
        />
      </div>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

