import type { Project } from "@gram/contracts";
import { Bookmark, FolderOpen, History } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { BookmarkToggle } from "./bookmark-toggle";
import { ForgetProjectButton } from "./forget-project-button";
import { GitBadge } from "./git-badge";
import { baseName } from "./path";

/** Folders worth one click, after the default folder when one is set. */
const SHORTCUTS = [
  { label: "~/Documents/code", path: "~/Documents/code" },
  { label: "Home", path: "~" },
];

const rowCls =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-accent";

/** Shortcut chips plus the recent and bookmarked projects. */
export function ProjectShortcuts({
  projects,
  current,
  defaultFolder,
  onChoose,
  onBrowse,
}: {
  projects: readonly Project[];
  /** The resolved chosen folder, to mark the matching project. */
  current: string | undefined;
  /** `Settings.agents.defaultFolder`; may contain `~`. */
  defaultFolder: string | undefined;
  onChoose: (root: string) => void;
  onBrowse: (path: string) => void;
}) {
  const shortcuts = defaultFolder
    ? [{ label: "Default folder", path: defaultFolder }, ...SHORTCUTS]
    : SHORTCUTS;
  // A bookmarked project is listed once, under Bookmarks.
  const recents = projects
    .filter((p) => p.lastOpenedAt !== undefined && !p.bookmarked)
    .toSorted((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 6);
  const bookmarks = projects.filter((p) => p.bookmarked);

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Shortcuts" className="flex flex-wrap gap-1">
        {shortcuts.map((shortcut) => (
          <button
            key={shortcut.label}
            type="button"
            title={shortcut.path}
            onClick={() => onBrowse(shortcut.path)}
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <FolderOpen aria-hidden className="size-3" />
            {shortcut.label}
          </button>
        ))}
      </div>
      {/* Full width, one above the other: side by side, each path was cut to half a column. */}
      {bookmarks.length > 0 && (
        <Section title="Bookmarks" icon={Bookmark}>
          {bookmarks.map((project) => (
            <ProjectRow key={project.id} project={project} current={current} onChoose={onChoose} />
          ))}
        </Section>
      )}
      <Section
        title="Recent"
        icon={History}
        empty={
          bookmarks.length > 0
            ? "Projects you open, other than bookmarks, show up here."
            : "Projects you open show up here."
        }
      >
        {recents.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            current={current}
            onChoose={onChoose}
            forgettable
          />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  empty,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** What an empty section says; a section that is absent while empty needs none. */
  empty?: string;
  children: ReactNode[];
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1">
      <h3 className="flex items-center gap-1.5 font-caption text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3" />
        {title}
      </h3>
      {children.length > 0 ? (
        <ul className="flex flex-col">{children}</ul>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function ProjectRow({
  project,
  current,
  onChoose,
  forgettable = false,
}: {
  project: Project;
  current: string | undefined;
  onChoose: (root: string) => void;
  /** Offers "Remove from recents" (the Recent section only). */
  forgettable?: boolean;
}) {
  const parent = project.root.slice(0, project.root.length - baseName(project.root).length);
  return (
    <li className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        aria-pressed={project.root === current}
        title={project.root}
        onClick={() => onChoose(project.root)}
        className={rowCls}
      >
        <span className="shrink-0 font-medium">{project.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {parent}
        </span>
        {project.repoRoot !== undefined && <GitBadge />}
      </button>
      <BookmarkToggle project={project} />
      {forgettable && <ForgetProjectButton project={project} />}
    </li>
  );
}
