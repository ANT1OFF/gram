import { Popover } from "@base-ui/react/popover";
import {
  cloneFolderOf,
  linkedCheckoutMessage,
  looksLikeFolderPath,
  notARepositoryMessage,
  parseRepoRemote,
  remoteLabel,
  type Project,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Folder, FolderCheck, FolderGit2, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";

import { ChooseFolderButton } from "./choose-folder-button";
import { GitBadge } from "./git-badge";
import { splitForCompletion, tildify } from "./path";
import { useCompletions, useFolderStatus, useHome, type FolderStatus } from "./use-folder";

const SUGGESTION_LIMIT = 8;

/**
 * The field owns open state (focus, blur, Escape, Enter). A portaled popup also dismisses on
 * outside press; cancelling that keeps a click in the field, and Escape inside a dialog, as they
 * are today.
 */
const keepSuggestionsOpen = (next: boolean, details: { cancel: () => void }) => {
  if (!next) details.cancel();
};

/** What the field's text asks for: a folder to add, a repository to clone, or neither yet. */
export type RepositoryInput =
  | { readonly kind: "empty" }
  | { readonly kind: "folder"; readonly path: string }
  | {
      readonly kind: "clone";
      readonly remote: string;
      readonly label: string;
      readonly repo: string;
    }
  | { readonly kind: "invalid"; readonly message: string };

export const readRepositoryInput = (text: string): RepositoryInput => {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (looksLikeFolderPath(trimmed)) return { kind: "folder", path: trimmed };
  const remote = parseRepoRemote(trimmed);
  return "error" in remote
    ? { kind: "invalid", message: remote.error }
    : { kind: "clone", remote: trimmed, label: remoteLabel(remote), repo: remote.repo };
};

/**
 * A typed folder once checked: a repository to add, why it can't be added, or one whose `.git`
 * couldn't be read, left to `projects.add` to say why.
 */
export type TypedFolder =
  | { readonly kind: "repo"; readonly path: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unchecked" };

/** What the folder check says of a typed path, as `projects.add` would; `undefined` until it has. */
export const typedFolder = (status: FolderStatus): TypedFolder | undefined => {
  if (status.state === "invalid") return { kind: "refused", message: status.problem.message };
  if (status.state !== "valid") return undefined;
  const { path, git } = status.folder;
  if (git === "unreadable") return { kind: "unchecked" };
  return git === "repository"
    ? { kind: "repo", path }
    : {
        kind: "refused",
        message: git === "linked" ? linkedCheckoutMessage(path) : notARepositoryMessage(path),
      };
};

/** Suggested `owner/repo` names containing `text`, prefix matches first. */
const matchRepos = (repos: readonly string[], text: string): string[] => {
  const q = text.trim().toLowerCase();
  if (q === "") return repos.slice(0, SUGGESTION_LIMIT);
  const scored = repos.flatMap((repo) => {
    const name = repo.toLowerCase();
    if (name === q) return [];
    const short = name.slice(name.indexOf("/") + 1);
    const score = name.startsWith(q) || short.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
    return score === -1 ? [] : [{ repo, score }];
  });
  return scored
    .toSorted((a, b) => a.score - b.score)
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => s.repo);
};

interface Suggestion {
  readonly key: string;
  readonly label: string;
  readonly kind: "repo" | "folder" | "gitFolder";
  /** The field's text once taken; a folder keeps the list open for the next level. */
  readonly value: string;
}

const cloneHint = (folder: string, repo: string) =>
  `Clones into ${folder}/${repo}, or adds the clone already there.`;

function CloneProgress({ id, label }: { id?: string; label: string }) {
  return (
    <p id={id} role="status" className="text-xs text-muted-foreground">
      <Shimmer>{label}</Shimmer>
    </p>
  );
}

/**
 * Registering a repository by folder or by cloning it, with what is under way and what failed:
 * the part of "Add repository" that the project picker's clone offer shares.
 */
function useRegisterRepository(onAdded: (project: Project) => void | Promise<void>) {
  const api = useApi();
  const queryClient = useQueryClient();
  const cloneFolder = useServerSettings((s) =>
    s.settings === undefined ? undefined : cloneFolderOf(s.settings),
  );
  /** Set while a repository is registered; `cloning` names the clone under way. */
  const [pending, setPending] = useState<{ cloning?: string }>();
  const [error, setError] = useState<string>();

  // A ref, not `pending`: a folder dialog opened before a clone began still answers after it did.
  const running = useRef(false);
  // Closing what holds the control (Cancel on a dialog) stops a clone under way, and nothing it
  // would have done follows: no workspace saved, no New thread opened.
  const unmounted = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => controller.abort();
  }, []);

  const register = async (
    add: (signal: AbortSignal) => Promise<Project>,
    cloning?: string,
  ): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setError(undefined);
    setPending(cloning === undefined ? {} : { cloning });
    const { signal } = unmounted.current;
    try {
      const project = await add(signal);
      // Registration succeeded even if a background refresh fails. Make the returned project
      // visible immediately, before selection, and refresh the discovery list independently.
      queryClient.setQueryData<Project[]>(["projects"], (projects = []) =>
        projects.some((each) => each.id === project.id)
          ? projects.map((each) => (each.id === project.id ? project : each))
          : [...projects, project],
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });

      if (signal.aborted) return false;
      await onAdded(project);
      return true;
    } catch (e) {
      if (!signal.aborted) setError(errorMessage(e) || "Couldn't add the repository. Try again.");
      return false;
    } finally {
      running.current = false;
      if (!signal.aborted) setPending(undefined);
    }
  };

  return {
    pending,
    error,
    setError,
    cloneFolder,
    addFolder: (path: string) => register(() => api.addProject(path)),
    clone: ({ remote, label, repo }: Extract<RepositoryInput, { kind: "clone" }>) => {
      const into = cloneFolder === undefined ? "" : ` into ${cloneFolder}/${repo}`;
      return register((signal) => api.cloneProject(remote, { signal }), `Cloning ${label}${into}…`);
    },
  };
}

/**
 * The project picker's answer to a typed `owner/repo` or git URL that isn't a folder: clone it
 * where new clones go, then pick the clone. Mounted for as long as that text is typed, so a clone
 * under way keeps its progress whatever the folder check says meanwhile; `children` stand in while
 * nothing is offered.
 */
export function CloneOffer({
  input,
  offered,
  onCloned,
  children,
}: {
  input: Extract<RepositoryInput, { kind: "clone" }>;
  /** False while the text is a folder after all, or the check hasn't said. */
  offered: boolean;
  onCloned: (project: Project) => void;
  children?: ReactNode;
}) {
  const { pending, error, cloneFolder, clone } = useRegisterRepository(onCloned);
  if (pending?.cloning !== undefined) return <CloneProgress label={pending.cloning} />;
  if (!offered && error === undefined) return children;
  return (
    <div className="flex flex-col gap-1" data-testid="clone-offer">
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <BookMarked aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {cloneFolder === undefined
            ? `${input.label} isn't a folder here.`
            : `${input.label} isn't a folder here. ${cloneHint(cloneFolder, input.repo)}`}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={pending !== undefined}
          onClick={() => void clone(input)}
        >
          Clone {input.label}
        </Button>
      </p>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface AddRepositoryHandle {
  /** Register the typed input, or do nothing when empty; false means failed or already pending. */
  submit(): Promise<boolean> | undefined;
}

export interface AddRepositoryProps {
  ref?: Ref<AddRepositoryHandle> | undefined;
  /**
   * Called with the project once it is registered, whether chosen, typed, cloned or found already
   * cloned. A rejection shows under the control like a failed clone does.
   */
  onAdded: (project: Project) => void | Promise<void>;
  /** An absolute folder the system folder dialog starts in. */
  defaultPath?: string | undefined;
  /** Disables the control, e.g. until the workspace it adds to has loaded. */
  disabled?: boolean | undefined;
  /** Lets a containing sheet wait for the registration before it creates the workspace. */
  onPendingChange?: ((pending: boolean) => void) | undefined;
}

/**
 * "Add repository": a GitHub `owner/repo` or git URL to clone, or a folder already on disk, typed
 * or pasted (with folder completion, and checked as it is typed) or picked with "Add folder…" in
 * the desktop app. Registers the project and hands it to `onAdded`, showing the clone's progress
 * and any error inline. Holds no `<form>`, so it can sit inside one.
 */
export function AddRepository({
  ref,
  onAdded,
  defaultPath,
  disabled,
  onPendingChange,
}: AddRepositoryProps) {
  const api = useApi();
  const listId = useId();
  const hintId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { pending, error, setError, cloneFolder, addFolder, clone } = useRegisterRepository(
    async (project) => {
      await onAdded(project);
      setText("");
    },
  );
  const input = readRepositoryInput(text);
  const home = useHome();
  const folderStatus = useFolderStatus(input.kind === "folder" ? input.path : "");
  const typed = typedFolder(folderStatus);
  useEffect(() => onPendingChange?.(pending !== undefined), [pending, onPendingChange]);
  const busy = pending !== undefined || disabled === true;

  // Asked for on mount, not on focus: a large organisation's first list takes seconds, and the
  // new-workspace sheet mounts this before its repository list is opened.
  const { data: suggested, isPending: suggesting } = useQuery({
    queryKey: ["clone-suggestions"],
    queryFn: () => api.cloneSuggestions(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const folders = useCompletions(text, open && input.kind === "folder");
  const { dir } = splitForCompletion(text);
  const suggestions: Suggestion[] =
    input.kind === "folder"
      ? folders.map((entry) => ({
          key: entry.path,
          label: entry.name,
          kind: entry.isGitRepo ? "gitFolder" : "folder",
          value: `${dir}${entry.name}/`,
        }))
      : matchRepos(suggested?.repos ?? [], text).map((repo) => ({
          key: repo,
          label: repo,
          kind: "repo",
          value: repo,
        }));
  const showList = open && !busy && suggestions.length > 0;

  const submit = (): Promise<boolean> | undefined => {
    if (input.kind === "empty") return;
    if (busy) return Promise.resolve(false);
    setOpen(false);
    // Enter doesn't wait for the check: the server refuses the same folders, in the same words.
    if (input.kind === "folder" && typed?.kind === "refused") setError(typed.message);
    else if (input.kind === "folder") return addFolder(input.path);
    else if (input.kind === "clone") return clone(input);
    else if (input.kind === "invalid") setError(input.message);
    return Promise.resolve(false);
  };

  useImperativeHandle(ref, () => ({ submit }));

  const accept = (suggestion: Suggestion) => {
    setText(suggestion.value);
    setActive(-1);
    setOpen(suggestion.kind !== "repo");
    setError(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (suggestions.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      case "Enter": {
        if (event.metaKey || event.ctrlKey) return;
        // Never the enclosing form's submit: Enter here adds the repository or takes a suggestion.
        event.preventDefault();
        const chosen = showList ? suggestions[active] : undefined;
        if (chosen) accept(chosen);
        else void submit();
        return;
      }
      case "Escape":
        if (!showList) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
    }
  };

  const loadingRepos = open && suggesting && input.kind !== "folder";
  const hint =
    input.kind === "clone" && cloneFolder !== undefined
      ? cloneHint(cloneFolder, input.repo)
      : "A folder's path, a GitHub repository such as owner/repo, or a git URL.";

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="add-repository">
      <div className="flex gap-1">
        <Popover.Root open={showList} onOpenChange={keepSuggestionsOpen} modal={false}>
          <div ref={anchorRef} className="min-w-0 flex-1">
            <input
              role="combobox"
              aria-label="Folder, GitHub repo or URL"
              aria-describedby={hintId}
              aria-autocomplete="list"
              aria-expanded={showList}
              aria-controls={listId}
              aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder="~/code/repo or owner/repo"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setActive(-1);
                setOpen(true);
                setError(undefined);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKeyDown}
            />
          </div>
          {showList && (
            <Popover.Portal>
              <Popover.Positioner
                anchor={anchorRef}
                side="bottom"
                align="start"
                sideOffset={4}
                // Same avoidance as a select: flip above the field, and limit height instead of
                // jumping to the side.
                collisionAvoidance={{ fallbackAxisSide: "none" }}
                className="isolate z-50"
              >
                <Popover.Popup
                  initialFocus={false}
                  finalFocus={false}
                  // The combobox list is the widget. The popup's default dialog role would nest one.
                  role="presentation"
                  className="w-(--anchor-width) max-w-(--available-width) outline-none"
                >
                  <ul
                    id={listId}
                    role="listbox"
                    aria-label={
                      input.kind === "folder" ? "Folder suggestions" : "Repository suggestions"
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    className="max-h-[min(16rem,var(--available-height))] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover"
                  >
                    {suggestions.map((suggestion, i) => {
                      const Icon =
                        suggestion.kind === "repo"
                          ? BookMarked
                          : suggestion.kind === "gitFolder"
                            ? FolderGit2
                            : Folder;
                      return (
                        <li
                          key={suggestion.key}
                          id={`${listId}-${i}`}
                          role="option"
                          aria-selected={i === active}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            accept(suggestion);
                          }}
                          onMouseEnter={() => setActive(i)}
                          className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 aria-selected:bg-accent"
                        >
                          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {suggestion.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          )}
        </Popover.Root>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={
            busy ||
            input.kind === "empty" ||
            (input.kind === "folder" && (typed === undefined || typed.kind === "refused"))
          }
          onClick={() => void submit()}
        >
          {input.kind === "clone" ? "Clone" : "Add"}
        </Button>
        <ChooseFolderButton
          label="Add folder…"
          defaultPath={defaultPath}
          disabled={busy}
          onChoose={addFolder}
        />
      </div>
      {pending?.cloning !== undefined ? (
        <CloneProgress id={hintId} label={pending.cloning} />
      ) : error !== undefined ? (
        <p id={hintId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : input.kind === "folder" && typed?.kind === "repo" ? (
        <p
          id={hintId}
          data-testid="folder-check"
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <FolderCheck aria-hidden className="size-3.5 shrink-0 text-success-text" />
          <span className="truncate font-mono">{tildify(typed.path, home)}</span>
          <GitBadge />
        </p>
      ) : input.kind === "folder" && typed?.kind === "refused" ? (
        <p
          id={hintId}
          data-testid="folder-check"
          className="flex items-start gap-1.5 text-xs text-warning-text"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {typed.message}
        </p>
      ) : loadingRepos ? (
        <p id={hintId} role="status" className="text-xs text-muted-foreground">
          <Shimmer>Loading your GitHub repositories…</Shimmer>
        </p>
      ) : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
