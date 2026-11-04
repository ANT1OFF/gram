import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { SettingsAnchor } from "./general-anchors";
import type { SettingsGroupId, SettingsNavGroup } from "./pages";

/**
 * Settings → the groups, one link each; the open one, or the one the open page opens from, is
 * `aria-current="page"`. In a narrow `@container/settings` it is a bar over the page instead, the
 * list folded into a picker, so the page keeps the width.
 */
export function SettingsNav({
  groups,
  current,
  sections,
  badges,
  headingRef,
  search,
  onNavigate,
}: {
  groups: readonly SettingsNavGroup[];
  /** The open group's id. */
  current: SettingsGroupId | undefined;
  /** The open page's subsections, linked under its group; none while searching or on a sub-page. */
  sections?: readonly SettingsAnchor[] | undefined;
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
              {group.id === current && sections !== undefined && sections.length > 0 && (
                <SectionLinks sections={sections} />
              )}
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

/**
 * The open page's subsections under its link: a click scrolls to one, and the one at the top of
 * the page is marked as you scroll.
 */
function SectionLinks({ sections }: { sections: readonly SettingsAnchor[] }) {
  const [active, pick] = useActiveSection(sections);
  return (
    <ul
      aria-label="On this page"
      data-testid="settings-page-sections"
      className="mt-0.5 mb-1 ms-[1.1875rem] flex flex-col border-s border-border/70 ps-1.5"
    >
      {sections.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            aria-current={section.id === active ? "location" : undefined}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(section.id)?.scrollIntoView({ block: "start" });
              pick(section.id);
            }}
            className="block rounded-md px-2 py-0.5 text-[0.8125rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=location]:text-foreground"
          >
            {section.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** How far below the scroller's top a subsection's top may be and still count as reached. */
const REACHED = 48;

/** The nearest ancestor that scrolls vertically, which is the page's own scroller. */
const scrollerOf = (element: HTMLElement): HTMLElement | undefined => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return undefined;
};

/**
 * The subsection whose top was last scrolled up to the top of the page, read on any scroll since
 * the page's scroller is the layout's and its groups may arrive after the nav. One picked from the
 * nav stays marked until the next scroll of its own, as the page's foot may stop short of it.
 */
function useActiveSection(
  sections: readonly SettingsAnchor[],
): [string | undefined, (id: string) => void] {
  const [active, setActive] = useState(sections[0]?.id);
  const picked = useRef<{ id: string; at: number }>(undefined);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const targets = sections
        .map((section) => document.getElementById(section.id))
        .filter((target): target is HTMLElement => target !== null);
      const first = targets[0];
      if (first === undefined) return;
      const top = scrollerOf(first)?.getBoundingClientRect().top ?? 0;
      let current = first.id;
      for (const target of targets) {
        if (target.getBoundingClientRect().top <= top + REACHED) current = target.id;
      }
      setActive(current);
    };
    const schedule = () => {
      // The scroll a pick itself makes lands within a frame or two; a later one is the user's.
      const pick = picked.current;
      if (pick !== undefined && performance.now() - pick.at < 250) return;
      picked.current = undefined;
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    frame = requestAnimationFrame(read);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      cancelAnimationFrame(frame);
    };
  }, [sections]);
  const pick = useCallback((id: string) => {
    picked.current = { id, at: performance.now() };
    setActive(id);
  }, []);
  return [active, pick];
}
