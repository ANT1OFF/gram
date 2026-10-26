import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { SettingsGroupId, SettingsNavGroup } from "./pages";

/**
 * Settings → the six groups, one link each; the open one, or the one the open page opens from, is
 * `aria-current="page"`. In a narrow `@container/settings` it is a bar over the page instead, the
 * list folded into a picker, so the page keeps the width.
 */
export function SettingsNav({
  groups,
  current,
  badges,
  headingRef,
  search,
  onNavigate,
}: {
  groups: readonly SettingsNavGroup[];
  /** The open group's id. */
  current: SettingsGroupId | undefined;
  /** Extra content after a group's label, keyed by its id, such as the update dot. */
  badges?: Readonly<Partial<Record<SettingsGroupId, ReactNode>>>;
  /** The "Settings" heading, focusable from script (tabIndex -1). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** The search box, between the heading and the list. */
  search?: ReactNode;
  /** A group's link was clicked. */
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="w-48 shrink-0 overflow-y-auto border-r border-border p-3 @max-2xl/settings:flex @max-2xl/settings:w-auto @max-2xl/settings:items-center @max-2xl/settings:gap-2 @max-2xl/settings:overflow-visible @max-2xl/settings:border-r-0 @max-2xl/settings:border-b @max-2xl/settings:py-2 @max-2xl/settings:*:data-search:mb-0 @max-2xl/settings:*:data-search:min-w-0 @max-2xl/settings:*:data-search:flex-1"
    >
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mb-2 px-2 font-heading text-base font-medium outline-none @max-2xl/settings:mb-0 @max-2xl/settings:shrink-0"
      >
        Settings
      </h1>
      {search}
      <SectionPicker groups={groups} current={current} onNavigate={onNavigate} />
      <ul className="flex flex-col gap-0.5 text-sm @max-2xl/settings:hidden">
        {groups.map((group) => {
          const Icon = group.icon;
          return (
            <li key={group.id}>
              <Link
                to={group.path}
                aria-current={group.id === current ? "page" : undefined}
                onClick={onNavigate}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                {group.label}
                {badges?.[group.id] !== undefined && (
                  <span className="ms-auto flex items-center">{badges[group.id]}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The groups as one picker, for the narrow bar; hidden while the list itself shows. */
function SectionPicker({
  groups,
  current,
  onNavigate,
}: {
  groups: readonly SettingsNavGroup[];
  current: SettingsGroupId | undefined;
  onNavigate: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const items = groups.map((group) => ({ value: group.id, label: group.label }));
  return (
    <div data-testid="settings-section-picker" className="hidden shrink-0 @max-2xl/settings:flex">
      <Select
        value={current ?? null}
        items={items}
        onValueChange={(id) => {
          const group = groups.find((g) => g.id === id);
          if (!group) return;
          onNavigate?.();
          void navigate({ to: group.path });
        }}
      >
        <SelectTrigger size="sm" aria-label="Settings section" className="max-w-44">
          <SelectValue placeholder="Section" />
        </SelectTrigger>
        <SelectContent align="end">
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id}>
              {group.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
