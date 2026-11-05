import {
  DEFAULT_CHUNK_HUNKS,
  generatedKind,
  type DiffChunk,
  type DiffCursor,
  type DiffFile,
  type DiffScope,
  type DiffSummary,
  type GeneratedKind,
  type ThreadId,
} from "@gram/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ListTree, ScrollText } from "lucide-react";
import { createContext, memo, use, useMemo, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import type { DiffLayout } from "@/stores/layout";

import { PatchView } from "./patch-view";

/** Where the files of the list came from, so a file too large for it can be asked for in chunks. */
export interface DiffChunkSource {
  threadId: ThreadId;
  scope: DiffScope;
  ignoreWhitespace: boolean;
}

export const DiffChunkSourceContext = createContext<DiffChunkSource | undefined>(undefined);

export const useDiffChunkSource = () => use(DiffChunkSourceContext);

/** Hunks a chunk asks for. */
export const CHUNK_HUNKS = DEFAULT_CHUNK_HUNKS;

/**
 * Patch lines one file's loaded chunks may hold in all. Past it the rest is read elsewhere, so a
 * file's loaded patch can't grow the panel without bound.
 */
export const MAX_LOADED_LINES = 10_000;

/** A patch row's height, for the space an off-screen chunk keeps while it isn't drawn. */
const ROW_PX = 20;

const KIND: Record<GeneratedKind, { what: string; sections: string }> = {
  lockfile: { what: "a lockfile", sections: "packages" },
  minified: { what: "minified code", sections: "sections" },
  "source map": { what: "a source map", sections: "sections" },
};

const scopeKey = (scope: DiffScope) =>
  scope.kind === "turn" ? `turn:${scope.turnId}` : scope.kind;

/** Lines of a chunk's patch, notes and headers left out. */
const patchLines = (patch: string) => patch.match(/^[ +-]/gm)?.length ?? 0;

const hunkHeaders = (patch: string) => patch.match(/^@@/gm)?.length ?? 0;

interface PageParam {
  readonly cursor?: DiffCursor;
  readonly fingerprint?: string;
}

/**
 * A file's chunks and summary, cached by file and by what the list said of it: collapsing the file,
 * switching turn and back, or a refresh that left it as it was keeps what was loaded. Nothing is
 * asked for until `load` or `summarize`.
 */
function useDiffChunks(source: DiffChunkSource, file: DiffFile) {
  const api = useApi();
  const key = [
    "git.diffChunk",
    source.threadId,
    scopeKey(source.scope),
    source.ignoreWhitespace,
    file.path,
    file.oldPath ?? null,
    file.additions,
    file.deletions,
  ] as const;
  const request = {
    scope: source.scope,
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    ...(source.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
  };
  const [hunksAsked, setHunksAsked] = useState(false);
  const [summaryAsked, setSummaryAsked] = useState(false);
  const hunks = useInfiniteQuery({
    queryKey: [...key, "hunks"],
    queryFn: ({ pageParam }: { pageParam: PageParam }) =>
      api.gitDiffChunk(source.threadId, {
        ...request,
        hunks: CHUNK_HUNKS,
        ...(pageParam.cursor === undefined ? {} : { cursor: pageParam.cursor }),
        ...(pageParam.fingerprint === undefined ? {} : { fingerprint: pageParam.fingerprint }),
      }),
    initialPageParam: {} as PageParam,
    getNextPageParam: (last: DiffChunk, all: DiffChunk[]): PageParam | undefined =>
      last.changed || last.next === undefined
        ? undefined
        : { cursor: last.next, fingerprint: all[0]!.fingerprint },
    enabled: hunksAsked,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const summary = useQuery({
    queryKey: [...key, "summary"],
    queryFn: () => api.gitDiffChunk(source.threadId, { ...request, mode: "summary" }),
    enabled: summaryAsked,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return {
    hunks,
    summary,
    load: () => setHunksAsked(true),
    summarize: () => setSummaryAsked(true),
  };
}

/**
 * Reviewing a file too large for the list here after all: its summary when it is generated, and its
 * hunks a chunk at a time. Each chunk is its own patch, drawn only while on screen, and the loaded
 * lines stop at `MAX_LOADED_LINES`. Picks and comments name hunks by their place in the file.
 */
export function ChunkedPatch({
  source,
  file,
  layout,
  wrap,
  children,
}: {
  source: DiffChunkSource;
  file: DiffFile;
  layout: DiffLayout;
  wrap: boolean;
  /** The ways to read it elsewhere, between the controls here and what they load. */
  children?: ReactNode;
}) {
  const { hunks, summary, load, summarize } = useDiffChunks(source, file);
  const kind = generatedKind(file.path);
  const pages = hunks.data?.pages ?? [];
  const loaded = pages.length > 0;
  const summarized = summary.data?.summary;
  const last = pages.at(-1);
  const lines = pages.reduce((sum, page) => sum + patchLines(page.patch), 0);
  // Each page's first hunk, counted across the pages before it (a few dozen pages at most).
  const offsets = pages.map((_, at) =>
    pages.slice(0, at).reduce((sum, page) => sum + hunkHeaders(page.patch), 0),
  );
  const changed = last?.changed === true;
  const full = lines >= MAX_LOADED_LINES;
  const first = pages[0];
  const binary = first?.binary === true || summary.data?.binary === true;

  const loadButton = (
    <Button
      type="button"
      size="xs"
      variant={kind === undefined ? "outline" : "ghost"}
      disabled={hunks.isFetching}
      onClick={load}
    >
      <ScrollText data-icon="inline-start" />
      {hunks.isFetching && !loaded ? "Loading hunks…" : `Load first ${CHUNK_HUNKS} hunks`}
    </Button>
  );
  const summaryButton = kind !== undefined && summarized === undefined && (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={summary.isFetching}
      onClick={summarize}
    >
      <ListTree data-icon="inline-start" />
      {summary.isFetching ? "Summarizing…" : "Summarize changes"}
    </Button>
  );

  return (
    <>
      {!loaded || summaryButton ? (
        <>
          <p className="text-muted-foreground">
            {kind === undefined
              ? `Load it here ${CHUNK_HUNKS} hunks at a time.`
              : `It's ${KIND[kind].what}: its summary lists the ${KIND[kind].sections} it changed, or load its hunks here ${CHUNK_HUNKS} at a time.`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {summaryButton}
            {!loaded && loadButton}
          </div>
        </>
      ) : null}
      {children}
      {summary.isError && (
        <p role="alert" className="text-destructive">
          Couldn't summarize it: {errorMessage(summary.error)}
        </p>
      )}
      {hunks.isError && (
        <p role="alert" className="text-destructive">
          Couldn't load its hunks: {errorMessage(hunks.error)}
        </p>
      )}
      {binary && (
        <p className="text-muted-foreground">It's a binary file: there are no lines to show.</p>
      )}
      {summarized && kind !== undefined && (
        <SummaryList summary={summarized} noun={KIND[kind].sections} />
      )}
      {loaded && !binary && (
        <div
          data-testid="diff-chunks"
          className="-mx-3 border-y border-border bg-card/40"
          aria-label={`Loaded hunks of ${file.path}`}
          role="group"
        >
          {pages.map((page, at) =>
            page.patch === "" ? null : (
              <ChunkPage
                // Pages only ever append, so a page's place is its identity.
                // oxlint-disable-next-line react/no-array-index-key
                key={at}
                file={file}
                patch={page.patch}
                hunkOffset={offsets[at]!}
                layout={layout}
                wrap={wrap}
              />
            ),
          )}
        </div>
      )}
      {loaded && !binary && last && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p role="status" aria-live="polite" className="text-muted-foreground">
            {chunkStatus(last, lines)}
          </p>
          {changed ? (
            <Button type="button" size="xs" variant="outline" onClick={() => void hunks.refetch()}>
              Reload hunks
            </Button>
          ) : (
            hunks.hasNextPage &&
            !full && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={hunks.isFetchingNextPage}
                onClick={() => void hunks.fetchNextPage()}
              >
                {hunks.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )
          )}
        </div>
      )}
      {loaded && changed && (
        <p className="text-muted-foreground">
          This file changed after its first hunks loaded. Reload to start again from the top.
        </p>
      )}
      {loaded && !changed && hunks.hasNextPage && full && (
        <p className="text-muted-foreground">
          That's {MAX_LOADED_LINES.toLocaleString("en-US")} lines, the most loaded here at once.
          Read the rest in your editor or a terminal.
        </p>
      )}
      {loaded && !changed && !hunks.hasNextPage && last?.partial && (
        <p className="text-muted-foreground">
          The rest of this patch is past what Gram reads of one file. Read it in your editor or a
          terminal.
        </p>
      )}
    </>
  );
}

/** How far the loaded hunks reach, in words. */
function chunkStatus(last: DiffChunk, lines: number) {
  const total = last.totalHunks;
  const count = `${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`;
  if (last.next === undefined) {
    return `All ${total.toLocaleString("en-US")} ${total === 1 ? "hunk" : "hunks"} loaded · ${count}`;
  }
  // A hunk the caps split counts once it has fully loaded.
  return `${last.next.hunk.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} hunks loaded · ${count}`;
}

/** One loaded chunk: drawn only while near the screen, keeping its height while it isn't. */
const ChunkPage = memo(function ChunkPage({
  file,
  patch,
  hunkOffset,
  layout,
  wrap,
}: {
  file: DiffFile;
  patch: string;
  hunkOffset: number;
  layout: DiffLayout;
  wrap: boolean;
}) {
  const chunk = useMemo(
    (): DiffFile => ({ ...file, patch, tooLarge: false, binary: false }),
    [file, patch],
  );
  const rows = patchLines(patch) + hunkHeaders(patch);
  return (
    <div
      data-testid="diff-chunk"
      style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${rows * ROW_PX}px` }}
    >
      <PatchView
        file={chunk}
        layout={layout}
        wrap={wrap}
        budget={Infinity}
        hunkOffset={hunkOffset}
      />
    </div>
  );
});

/** Sections a summary shows before "Show all". */
const SUMMARY_ROWS = 12;

function SummaryList({ summary, noun }: { summary: DiffSummary; noun: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? summary.sections : summary.sections.slice(0, SUMMARY_ROWS);
  const hidden = summary.sections.length - shown.length;
  const changed = summary.sections.length + summary.moreSections;
  return (
    <section
      data-testid="diff-summary"
      aria-label="Summary of changes"
      className="flex flex-col gap-1"
    >
      <p className="text-foreground">
        {changed.toLocaleString("en-US")} {changed === 1 ? noun.replace(/s$/, "") : noun} changed
        over {summary.hunks.toLocaleString("en-US")} {summary.hunks === 1 ? "hunk" : "hunks"} ·{" "}
        <span className="font-mono tabular-nums">
          <span className="text-success">+{summary.additions.toLocaleString("en-US")}</span>{" "}
          <span className="text-destructive">−{summary.deletions.toLocaleString("en-US")}</span>
        </span>
      </p>
      <ul className="flex flex-col">
        {shown.map((section) => (
          <li key={section.name} className="flex items-baseline gap-3 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono" title={section.name}>
              {section.name}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              <span className="text-success">+{section.additions}</span>{" "}
              <span className="text-destructive">−{section.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || summary.moreSections > 0) && (
        <div className="flex flex-wrap items-center gap-x-3">
          {hidden > 0 && (
            <Button type="button" size="xs" variant="ghost" onClick={() => setAll(true)}>
              Show all {summary.sections.length.toLocaleString("en-US")}
            </Button>
          )}
          {summary.moreSections > 0 && (
            <span className="text-muted-foreground">
              {summary.moreSections.toLocaleString("en-US")} more not listed
            </span>
          )}
        </div>
      )}
    </section>
  );
}
