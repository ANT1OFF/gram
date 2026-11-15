import { Popover } from "@base-ui/react/popover";
import { parseRepoRemote, type Project } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Lock, Plus, X } from "lucide-react";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";

import { folderLabel } from "./path";
import { useRepoSuggestions } from "./repository-suggestions";

const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-edge bg-card px-2 text-meta outline-none";
const FOCUS = "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent";

/**
 * The repositories a thread also uses beside the one it works in: their folders are given to its
 * agent as `/add-dir` gives one. Picked from the repositories Gram has, or cloned from those the
 * person can reach (or any they type) the moment they pick one.
 */
export function AlsoRepositories({
  primary,
  roots,
  projects,
  onChange,
}: {
  /** The folder it works in: never offered here. */
  readonly primary: string;
  readonly roots: readonly string[];
  /** The known projects: the repositories among them are offered first. */
  readonly projects: readonly Project[];
  readonly onChange: (roots: readonly string[]) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [cloning, setCloning] = useState<string>();
  const [error, setError] = useState<string>();
  const inputId = useId();
  const suggestions = useRepoSuggestions(text, open);

  const known = projects.filter(
    (project) =>
      project.repoRoot !== undefined && project.root !== primary && !roots.includes(project.root),
  );
  const typed = text.trim().toLowerCase();
  const listed = known.filter(
    (project) => typed === "" || folderLabel(project.root).toLowerCase().includes(typed),
  );
  const have = new Set(projects.map((project) => folderLabel(project.root).toLowerCase()));
  const reachable = suggestions.groups
    .flatMap((group) => group.repos)
    .filter((repo) => !have.has(repo.toLowerCase()))
    .slice(0, 8);

  const add = (root: string) => {
    onChange([...roots, root]);
    setText("");
    setOpen(false);
  };
  const clone = (remote: string) => {
    if (cloning !== undefined) return;
    setCloning(remote);
    setError(undefined);
    setOpen(false);
    api
      .cloneProject(remote)
      .then(async (project) => {
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        if (project.root !== primary && !roots.includes(project.root))
          onChange([...roots, project.root]);
        setText("");
      })
      .catch((cause: unknown) => setError(errorMessage(cause) || `Couldn't clone ${remote}.`))
      .finally(() => setCloning(undefined));
  };
  const typedRemote = text.trim() !== "" && !("error" in parseRepoRemote(text.trim()));

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="also-repositories">
      {roots.map((root) => (
        <span key={root} className={cn(CHIP, "pe-1")} title={root}>
          <FolderGit2 aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="truncate">{folderLabel(root)}</span>
          <button
            type="button"
            aria-label={`Don't use ${folderLabel(root)}`}
            className={cn("rounded-sm p-0.5 text-muted-foreground hover:bg-accent", FOCUS)}
            onClick={() => onChange(roots.filter((each) => each !== root))}
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {cloning !== undefined && (
        <span className={CHIP} aria-live="polite">
          <Spinner className="size-3.5" />
          <span className="truncate">Cloning {cloning}…</span>
        </span>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          data-testid="also-repositories-add"
          className={cn(CHIP, FOCUS, "border-dashed text-muted-foreground hover:bg-accent")}
          aria-label="Also use another repository"
        >
          <Plus aria-hidden className="size-icon-row shrink-0" />
          Repository
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
            <Popover.Popup
              data-surface="overlay"
              aria-label="Also use a repository"
              className="flex w-96 origin-(--transform-origin) flex-col gap-1 rounded-md border border-edge bg-popover p-1 text-reading text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const only = listed.length === 1 ? listed[0] : undefined;
                  if (only !== undefined) add(only.root);
                  else if (typedRemote) clone(text.trim());
                }}
              >
                <label className="sr-only" htmlFor={inputId}>
                  Search, or type owner/name
                </label>
                <input
                  id={inputId}
                  autoFocus
                  className="h-8 w-full rounded-sm border border-edge-group bg-transparent px-2 text-body outline-none focus-visible:border-ring"
                  placeholder="Search, or type owner/name"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </form>
              <div className="max-h-80 overflow-y-auto">
                {listed.length > 0 && (
                  <section aria-label="Here already">
                    <h3 className="px-2 pt-1.5 pb-1 text-meta text-muted-foreground">
                      Here already
                    </h3>
                    {listed.slice(0, 8).map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        className={ROW}
                        title={project.root}
                        onClick={() => add(project.root)}
                      >
                        <FolderGit2 aria-hidden className="size-icon-row shrink-0" />
                        <span className="truncate">{folderLabel(project.root)}</span>
                      </button>
                    ))}
                  </section>
                )}
                {reachable.length > 0 && (
                  <section aria-label="Cloned when picked">
                    <h3 className="px-2 pt-1.5 pb-1 text-meta text-muted-foreground">
                      Cloned when picked
                    </h3>
                    {reachable.map((repo) => (
                      <button key={repo} type="button" className={ROW} onClick={() => clone(repo)}>
                        <FolderGit2 aria-hidden className="size-icon-row shrink-0" />
                        <span className="truncate">{repo}</span>
                        {suggestions.private.has(repo) && (
                          <Lock
                            aria-label="Private"
                            className="ms-auto size-3 shrink-0 text-muted-foreground"
                          />
                        )}
                      </button>
                    ))}
                  </section>
                )}
                {typedRemote && !reachable.includes(text.trim()) && (
                  <button type="button" className={ROW} onClick={() => clone(text.trim())}>
                    <Plus aria-hidden className="size-icon-row shrink-0" />
                    <span className="truncate">Clone {text.trim()}</span>
                  </button>
                )}
                {listed.length === 0 && reachable.length === 0 && !typedRemote && (
                  <p className="px-2 py-1.5 text-meta text-muted-foreground">
                    {suggestions.loading
                      ? "Looking for your repositories…"
                      : "Type a repository as owner/name, or a git URL."}
                  </p>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {error !== undefined && (
        <span role="alert" className="text-meta text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
