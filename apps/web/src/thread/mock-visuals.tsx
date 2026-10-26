import {
  boardSlug,
  joinPreviewTarget,
  mockRefKind,
  parseMockRecord,
  pathName,
  shotFor,
  splitPreviewTarget,
  type MockCardData,
  type QuestionChoice,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, LayoutDashboard, Star } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { imageDataUrl, useCheckoutImage } from "@/panels/files/image-preview";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";

import { AttachmentLightbox } from "./attachment-lightbox";

// Mocks shown as pictures (docs/orchestration/playbooks/mock-first.md): a question's options with
// their screenshots and an "Open mock" each, and the card `show_mock` puts in a reply. Every path
// was confined to the asking thread's folders by the server; pictures are read back through
// `fs.image` and pages through `fs.preview`, which confine them again. A card names a file only by
// its name, never by its path.

export type MockTheme = "dark" | "light";

/** The mode the app is drawn in, which a mock card shows its screenshots in first. */
const appMode = (): MockTheme =>
  document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";

/** Whether a choice shows anything: a screenshot, or a mock page to open. */
const hasVisuals = (option: QuestionChoice): boolean =>
  option.image !== undefined || option.preview !== undefined;

/**
 * Opens a mock page in `threadId`'s Preview tab, at its board and in a theme, going to the thread
 * first: the tab sits beside it, wherever the click came from (the Board, the ask stack).
 */
function useOpenMock() {
  const navigate = useNavigate();
  const previewPane = useFeature("previewPane");
  return (threadId: ThreadId, target: string, theme?: MockTheme) => {
    const { path, board } = splitPreviewTarget(target);
    const layout = useLayoutStore.getState();
    layout.openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
    // The kit focuses a board by its id, which is its name slugged.
    layout.previewFile(
      threadId,
      joinPreviewTarget(path, board === undefined ? undefined : boardSlug(board)),
      { previewPane, thread: true, ...(theme === undefined ? {} : { theme }) },
    );
  };
}

/** A mock's screenshot as a thumbnail, enlarged in the lightbox on a click. */
export function MockThumb({
  threadId,
  path,
  label,
}: {
  threadId: ThreadId;
  path: string;
  /** What it shows: the option or the direction. */
  label: string;
}) {
  const query = useCheckoutImage(threadId, path);
  const name = pathName(path);
  const src = imageDataUrl(query.data);
  const frame = "aspect-[16/10] w-full rounded-md border border-border";
  if (query.status === "pending") {
    return <div data-testid="mock-thumb-loading" aria-hidden className={cn(frame, "bg-muted")} />;
  }
  if (src === undefined) {
    return (
      <div
        data-testid="mock-thumb-missing"
        className={cn(
          frame,
          "flex items-center justify-center border-dashed px-2 text-center text-[11px] text-muted-foreground",
        )}
      >
        {name} can't be shown
      </div>
    );
  }
  return (
    <AttachmentLightbox
      src={src}
      name={`${label} · ${name}`}
      description={`Enlarge ${label}`}
      triggerClassName="w-full"
      thumbnailClassName="aspect-[16/10] w-full object-cover object-top"
    />
  );
}

/** The page a question's `mock` opens: the page itself, or the current version its mock.json names. */
function useMockPage(threadId: ThreadId, mock: string | undefined): string | undefined {
  const api = useApi();
  const record = mock !== undefined && mockRefKind(mock) === "record";
  const query = useQuery({
    queryKey: ["mock-record", threadId, mock],
    queryFn: () => api.fsFile(mock!, { threadId }),
    enabled: record,
    retry: false,
    staleTime: 30_000,
  });
  if (mock === undefined) return undefined;
  if (!record) return mock;
  const parsed =
    query.data?.content === undefined ? undefined : parseMockRecord(query.data.content);
  const version =
    parsed?.versions.find((each) => each.n === parsed.current) ?? parsed?.versions.at(-1);
  if (version === undefined) return undefined;
  const folder = mock.slice(0, mock.length - pathName(mock).length);
  return `${folder}${version.file}`;
}

/**
 * A question's options as pictures: a tile per option with a screenshot or a mock page, its
 * label, and "Open mock" at its board; and "Open mocks" for the mock the question is about.
 * Nothing when the question shows neither.
 */
export function OptionGallery({
  threadId,
  options,
  recommended,
  mock,
  className,
}: {
  /** The thread that asked, whose folders the pictures are in and whose Preview opens them. */
  threadId: ThreadId;
  options: readonly QuestionChoice[];
  recommended?: string | undefined;
  mock?: string | undefined;
  className?: string;
}) {
  const open = useOpenMock();
  const page = useMockPage(threadId, mock);
  const shown = options.filter(hasVisuals);
  if (shown.length === 0 && mock === undefined) return null;
  return (
    <div data-testid="option-gallery" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {shown.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {shown.map((option) => (
            <li
              key={option.label}
              data-testid="option-visual"
              data-option={option.label}
              className="flex min-w-0 flex-col gap-1"
            >
              {option.image !== undefined ? (
                <MockThumb threadId={threadId} path={option.image} label={option.label} />
              ) : (
                <button
                  type="button"
                  aria-label={`Open the mock of ${option.label}`}
                  onClick={() => open(threadId, option.preview!)}
                  className="flex aspect-[16/10] w-full items-center justify-center rounded-md border border-dashed border-border text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <LayoutDashboard aria-hidden className="size-4" />
                </button>
              )}
              <span className="flex min-w-0 items-center gap-1 text-xs">
                <span className="min-w-0 truncate font-medium">{option.label}</span>
                {option.label === recommended && (
                  <span title="Recommended" className="inline-flex shrink-0 text-status-needs">
                    <Star aria-hidden className="size-3 fill-current" />
                    <span className="sr-only">(recommended)</span>
                  </span>
                )}
              </span>
              {option.preview !== undefined && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="option-open-mock"
                  aria-label={`Open mock: ${option.label}`}
                  className="-ml-1.5 self-start"
                  onClick={() => open(threadId, option.preview!)}
                >
                  <ExternalLink data-icon="inline-start" />
                  Open mock
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {mock !== undefined && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="question-open-mocks"
          className="self-start"
          disabled={page === undefined}
          title={pathName(mock)}
          onClick={() => page !== undefined && open(threadId, page)}
        >
          <LayoutDashboard data-icon="inline-start" />
          Open mocks
        </Button>
      )}
    </div>
  );
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: "Draft",
  "in-review": "In review",
  approved: "Approved",
};

/**
 * What `show_mock` puts in a reply: the mock's title and version, a thumbnail per direction with
 * dark and light when both were taken, and Open in Preview, at a direction's board where the
 * record names one.
 */
export function MockCard({ threadId, mock }: { threadId: ThreadId; mock: MockCardData }) {
  const open = useOpenMock();
  const themed = mock.directions.some(
    (direction) => direction.shots.dark !== undefined && direction.shots.light !== undefined,
  );
  const [theme, setTheme] = useState<MockTheme>(appMode);
  const openAt = (board: string | undefined) =>
    open(threadId, joinPreviewTarget(mock.page, board), themed ? theme : undefined);
  const status = mock.status === undefined ? undefined : (STATUS_WORDS[mock.status] ?? mock.status);
  return (
    <section
      data-testid="mock-card"
      data-shots={theme}
      aria-label={`Mock: ${mock.title}`}
      className="my-2 flex w-full max-w-xl min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-card p-3"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <LayoutDashboard aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate font-heading text-sm font-semibold">{mock.title}</h3>
        {mock.version !== undefined && (
          <span data-testid="mock-version" className="font-mono text-xs text-muted-foreground">
            v{mock.version}
          </span>
        )}
        {status !== undefined && (
          <span
            data-testid="mock-status"
            className={cn(
              "rounded-sm border px-1.5 text-[11px]",
              mock.status === "approved"
                ? "border-success/40 text-success"
                : "border-border text-muted-foreground",
            )}
          >
            {status}
          </span>
        )}
      </header>
      {mock.directions.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {mock.directions.map((direction) => {
            const shot = shotFor(direction.shots, theme);
            return (
              <li
                key={direction.name}
                data-testid="mock-direction"
                data-direction={direction.name}
                className="flex min-w-0 flex-col gap-1"
              >
                {shot === undefined ? (
                  <div className="aspect-[16/10] w-full rounded-md border border-dashed border-border" />
                ) : (
                  <MockThumb key={shot} threadId={threadId} path={shot} label={direction.name} />
                )}
                <span className="flex min-w-0 items-center gap-1 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium">{direction.name}</span>
                  {direction.board !== undefined && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Open ${direction.name} in Preview`}
                      onClick={() => openAt(direction.board)}
                    >
                      <ExternalLink />
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No screenshots yet: they go in the mock's shots folder.
        </p>
      )}
      <footer className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="mock-open-preview"
          onClick={() => openAt(undefined)}
        >
          <ExternalLink data-icon="inline-start" />
          Open in Preview
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {pathName(mock.page)}
        </span>
        {themed && (
          <div
            role="group"
            aria-label="Screenshots"
            className="flex shrink-0 rounded-md border border-border p-0.5"
          >
            {(["dark", "light"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={theme === mode}
                onClick={() => setTheme(mode)}
                className="rounded-sm px-2 py-0.5 text-xs text-muted-foreground capitalize outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-foreground"
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </footer>
    </section>
  );
}
