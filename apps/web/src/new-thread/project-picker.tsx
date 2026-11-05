import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, FolderCheck, FolderSearch } from "lucide-react";
import { useId } from "react";

import { FolderAccessRecovery } from "@/components/folder-access-recovery";
import { Button } from "@/components/ui/button";
import { Expand, Shimmer } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";

import { CloneOffer, readRepositoryInput } from "./add-repository";
import { ChooseFolderButton } from "./choose-folder-button";
import { FolderBrowser } from "./folder-browser";
import { GitBadge } from "./git-badge";
import { PathField } from "./path-field";
import { ShortcutChips } from "./project-shortcuts";
import { SetDefaultFolder } from "./set-default-folder";
import { useProjectPickerStore } from "./store";
import { tildify } from "./path";
import { useHome, useIsGitRepo, type FolderStatus } from "./use-folder";

interface ProjectPickerProps {
  value: string;
  onChange: (value: string) => void;
  /** From `useFolderStatus(value)`; the draft gates Create on it. */
  status: FolderStatus;
  debounceMs?: number;
}

/**
 * Where a new thread runs, by path: typed, or found in the folder browser. Recent and bookmarked
 * projects are the folder chip's menu (`FolderPicker`). A typed `owner/repo` or git URL that isn't a
 * folder is offered for cloning.
 */
export function ProjectPicker({ value, onChange, status, debounceMs }: ProjectPickerProps) {
  const browserId = useId();
  const browserOpen = useProjectPickerStore((s) => s.browserOpen);
  const setBrowserOpen = useProjectPickerStore((s) => s.setBrowserOpen);
  const browseTo = useProjectPickerStore((s) => s.browseTo);
  const defaultFolder = useServerSettings((s) => s.settings?.agents.defaultFolder);
  const chosen = status.state === "valid" ? status.folder.path : undefined;
  const typed = readRepositoryInput(value);

  const openBrowserAt = (path: string) => {
    browseTo(path);
    setBrowserOpen(true);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-meta font-medium text-muted-foreground">Project</legend>
      <div className="flex gap-1">
        <PathField
          value={value}
          onChange={onChange}
          {...(debounceMs !== undefined ? { debounceMs } : {})}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          aria-expanded={browserOpen}
          aria-controls={browserId}
          onClick={() => {
            if (browserOpen) setBrowserOpen(false);
            else if (chosen) openBrowserAt(chosen);
            else if (defaultFolder) openBrowserAt(defaultFolder);
            else setBrowserOpen(true);
          }}
        >
          <FolderSearch data-icon="inline-start" />
          Browse
        </Button>
        <ChooseFolderButton defaultPath={chosen} onChoose={onChange} />
      </div>
      {typed.kind === "clone" ? (
        <CloneOffer
          key={typed.remote}
          input={typed}
          offered={status.state === "invalid" && !status.problem.access}
          onCloned={(project) => onChange(project.root)}
        >
          <FolderStatusLine status={status} />
        </CloneOffer>
      ) : (
        <FolderStatusLine status={status} />
      )}
      <Expand open={browserOpen} id={browserId}>
        <div className="mt-1 overflow-hidden rounded-lg border border-edge bg-card">
          {browserOpen && (
            <FolderBrowser
              onChoose={(path) => {
                onChange(path);
                setBrowserOpen(false);
              }}
            />
          )}
        </div>
      </Expand>
      <ShortcutChips
        defaultFolder={defaultFolder}
        onBrowse={(path) => {
          onChange(path === "~" ? "~/" : `${path}/`);
          openBrowserAt(path);
        }}
      />
    </fieldset>
  );
}

function FolderStatusLine({ status }: { status: FolderStatus }) {
  const queryClient = useQueryClient();
  const home = useHome();
  const isGitRepo = useIsGitRepo(status.state === "valid" ? status.folder : undefined);
  switch (status.state) {
    case "empty":
      return (
        <p className="text-meta text-muted-foreground">
          Type a path, browse, or pick a project from the folder chip.
        </p>
      );
    case "checking":
      return (
        <p role="status" className="text-meta text-muted-foreground">
          <Shimmer>Checking folder…</Shimmer>
        </p>
      );
    case "invalid":
      return status.problem.access ? (
        <div className="rounded-lg border border-edge bg-card">
          <FolderAccessRecovery
            denial={status.problem.access}
            message={status.problem.message}
            onRetry={() => void queryClient.invalidateQueries({ queryKey: ["fs.browse"] })}
          />
        </div>
      ) : (
        <p
          role="alert"
          data-testid="folder-problem"
          className="flex items-center gap-1.5 text-meta text-danger-text"
        >
          <CircleAlert aria-hidden className="size-3.5 shrink-0" />
          {status.problem.message}
        </p>
      );
    case "valid":
      return (
        <p
          role="status"
          data-testid="folder-status"
          className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground"
        >
          <FolderCheck aria-hidden className="size-3.5 shrink-0 text-success-text" />
          <span className="truncate font-mono">{tildify(status.folder.path, home)}</span>
          {isGitRepo === true && <GitBadge />}
          {isGitRepo === false && <span>Not a git repository</span>}
          <SetDefaultFolder path={status.folder.path} home={home} />
        </p>
      );
  }
}
