import { Menu } from "@base-ui/react/menu";
import { PreviewCard } from "@base-ui/react/preview-card";
import type { ThreadId } from "@gram/contracts";
import { Copy, ExternalLink, FolderOpen, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { openThreadPanel } from "@/components/git-badges";
import { PR_GLYPH_DISPLAY, prGlyphOf, prGlyphWords } from "@/components/pr-glyph-model";
import type { PrFacts } from "@/components/pr-marks-model";
import { revealLabel, useOpensLocally, useRevealInFileManager } from "@/editor/use-open-in-editor";
import { formatCount } from "@/lib/format";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { openTerminalIn, terminalProblem } from "@/panels/terminal/terminals-store";
import type { PrDetailPrewarmHandlers } from "@/panels/use-pr-detail-prewarm";
import { copyText } from "@/settings/copy-text";
import { useThreadsStore } from "@/stores/threads";

import type { PrRowCard, PrRowPlace } from "./pr-strip-model";

const FOCUS = "focus-visible:ring-3 focus-visible:ring-ring/50";
/** One clickable word of a row: it lights up on its own, so the row reads as three links, not one. */
const LINK = cn(
  "rounded-sm px-1 py-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
  FOCUS,
);
const SURFACE =
  "origin-(--transform-origin) rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/**
 * A row's PR number. Hovering it shows what the PR is; clicking it goes there, which `onOpen`
 * decides: the PR panel for the thread's own PR, GitHub for one it only follows.
 */
export function PrNumberLink({
  number,
  facts,
  place,
  card,
  title,
  onOpen,
  prewarm,
}: {
  number: number;
  /** The row's facts, for the card's state: the row's own glyph, in words. */
  facts: PrFacts | undefined;
  place: PrRowPlace;
  card: PrRowCard;
  title: string;
  onOpen: () => void;
  /** Set where `onOpen` opens the PR panel, so resting on the number fetches what it will show. */
  prewarm?: PrDetailPrewarmHandlers | undefined;
}) {
  const glyph = facts === undefined ? undefined : prGlyphOf(facts);
  const display = glyph === undefined ? undefined : PR_GLYPH_DISPLAY[glyph.kind];
  const stats = card.additions !== undefined && card.deletions !== undefined;
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        render={<button type="button" />}
        data-testid="pr-row-number"
        title={title}
        delay={300}
        className={cn(LINK, "shrink-0 tabular-nums hover:underline")}
        onClick={onOpen}
        {...prewarm}
      >
        #{number}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" align="start" sideOffset={8} className="isolate z-50">
          <PreviewCard.Popup
            data-testid="pr-row-card"
            data-surface="overlay"
            className={cn(SURFACE, "flex w-80 flex-col gap-2 p-3 text-sm")}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {display && (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5",
                    display.tone,
                  )}
                >
                  <display.icon aria-hidden className="size-3" />
                  {prGlyphWords(facts)}
                </span>
              )}

              <span className="min-w-0 truncate">
                {place.fullRepo ?? place.repo} #{number}
              </span>
              {card.updatedAt !== undefined && (
                <span className="ml-auto shrink-0">{formatRelative(card.updatedAt)}</span>
              )}
            </div>
            {card.title !== undefined && <p className="line-clamp-3 font-medium">{card.title}</p>}
            {(card.author !== undefined || stats || card.changedFiles !== undefined) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {card.author !== undefined && <span className="truncate">{card.author}</span>}
                {stats && (
                  <span className="ml-auto flex shrink-0 gap-1 tabular-nums">
                    <span className="text-success">+{formatCount(card.additions ?? 0)}</span>
                    <span className="text-destructive">−{formatCount(card.deletions ?? 0)}</span>
                  </span>
                )}
                {card.changedFiles !== undefined && (
                  <span className={cn("shrink-0 tabular-nums", !stats && "ml-auto")}>
                    {card.changedFiles === 1 ? "1 file" : `${formatCount(card.changedFiles)} files`}
                  </span>
                )}
              </div>
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function LinkMenu({
  testId,
  label,
  className,
  trigger,
  children,
}: {
  testId: string;
  label: string;
  className?: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger data-testid={testId} aria-label={label} className={cn(LINK, className)}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="isolate z-50">
          <Menu.Popup
            data-testid={`${testId}-menu`}
            data-surface="overlay"
            className={cn(SURFACE, "min-w-48 p-1")}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const Separator = () => <Menu.Separator className="-mx-1 my-1 h-px bg-border" />;

/** Where the thread runs now: the checkout it followed the agent into, else the one it launched in. */
const useThreadFolder = (threadId: ThreadId): string | undefined =>
  useThreadsStore((s) => {
    const thread = s.byId[threadId]?.thread;
    return thread?.currentCheckout?.path ?? thread?.checkout.path;
  });

/** Opens the terminal panel on a shell started in `folder`, not on whichever one the thread had. */
function OpenTerminalItem({ threadId, folder }: { threadId: ThreadId; folder: string }) {
  const api = useApi();
  return (
    <Menu.Item
      className={ITEM}
      onClick={() => {
        openThreadPanel(threadId, "terminal");
        openTerminalIn(api, threadId, folder).catch((error: unknown) =>
          useThreadsStore.getState().applyEvent({
            type: "notify",
            kind: "error",
            title: "Couldn't open a terminal there",
            body: terminalProblem(error),
          }),
        );
      }}
    >
      <SquareTerminal aria-hidden className="size-3.5" />
      Open in terminal
    </Menu.Item>
  );
}

/**
 * A row's repository: its page on GitHub, and the folder and terminal when the thread's checkout is
 * a clone of it. A PR bound from another repository has no folder here, so it gets neither.
 */
export function RepoLink({ threadId, place }: { threadId: ThreadId; place: PrRowPlace }) {
  const api = useApi();
  const reveal = useRevealInFileManager();
  const opensLocally = useOpensLocally();
  const folder = useThreadFolder(threadId);
  const { repo, fullRepo, repoUrl } = place;
  if (repo === undefined) return null;
  const local = place.localRepo && folder !== undefined && opensLocally ? folder : undefined;
  return (
    <LinkMenu
      testId="pr-row-repo"
      label={`Repository ${fullRepo ?? repo}`}
      className="shrink-0"
      trigger={repo}
    >
      {local !== undefined && (
        <Menu.Item className={ITEM} onClick={() => void reveal(local, { threadId })}>
          <FolderOpen aria-hidden className="size-3.5" />
          {revealLabel()}
        </Menu.Item>
      )}
      {repoUrl !== undefined && (
        <Menu.Item className={ITEM} onClick={() => void openExternalUrl(api, repoUrl)}>
          <ExternalLink aria-hidden className="size-3.5" />
          Open repository on GitHub
        </Menu.Item>
      )}
      <Separator />
      {local === undefined ? (
        <Menu.Item
          className={ITEM}
          onClick={() => void copyText(fullRepo ?? repo).catch(() => undefined)}
        >
          <Copy aria-hidden className="size-3.5" />
          Copy repository name
        </Menu.Item>
      ) : (
        <>
          <Menu.Item className={ITEM} onClick={() => void copyText(local).catch(() => undefined)}>
            <Copy aria-hidden className="size-3.5" />
            Copy path
          </Menu.Item>
          <Separator />
          <OpenTerminalItem threadId={threadId} folder={local} />
        </>
      )}
    </LinkMenu>
  );
}

/** A row's branch: copy its name, and the terminal when it is the branch checked out here. */
export function BranchLink({ threadId, place }: { threadId: ThreadId; place: PrRowPlace }) {
  const folder = useThreadFolder(threadId);
  const { branch } = place;
  if (branch === undefined) return null;
  return (
    <LinkMenu
      testId="pr-row-branch"
      label={`Branch ${branch}`}
      className="min-w-0 truncate text-muted-foreground/80"
      trigger={branch}
    >
      <Menu.Item className={ITEM} onClick={() => void copyText(branch).catch(() => undefined)}>
        <Copy aria-hidden className="size-3.5" />
        Copy branch name
      </Menu.Item>
      {place.localBranch && folder !== undefined && (
        <>
          <Separator />
          <OpenTerminalItem threadId={threadId} folder={folder} />
        </>
      )}
    </LinkMenu>
  );
}
