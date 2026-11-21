import { Popover } from "@base-ui/react/popover";
import { checkoutRoots, isCredentialPath, type ThreadId } from "@gram/contracts";
import { Copy, Eye, FolderOpen, SquareArrowUpRightExit } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { Api } from "@/api/types";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  revealLabel,
  useOpenInEditor,
  useOpensLocally,
  useRevealInFileManager,
} from "@/editor/use-open-in-editor";
import { isMac } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { showFileAt } from "@/panels/files/files-store";
import { copyText } from "@/settings/copy-text";
import { useFeature } from "@/settings/use-diagnostics";
import { useThreadsStore } from "@/stores/threads";

import { createFileRefResolver, type FileRefResolver } from "./file-ref-resolver";
import { FILE_REF_TAG, mayBeInRoots, positionLabel } from "./file-refs";

interface FileRefsScope {
  readonly threadId: ThreadId;
  readonly roots: readonly string[];
  readonly resolver: FileRefResolver;
}

const FileRefsContext = createContext<FileRefsScope | undefined>(undefined);

/** The thread and checkouts file references resolve in; `undefined` outside a transcript. */
export const useFileRefsScope = () => use(FileRefsContext);

const resolvers = new WeakMap<Api, FileRefResolver>();

const resolverFor = (api: Api) => {
  let resolver = resolvers.get(api);
  if (resolver === undefined) {
    resolver = createFileRefResolver((threadId, paths) => api.fsResolve(threadId, paths));
    resolvers.set(api, resolver);
  }
  return resolver;
};

/**
 * Resolves file references in `threadId`'s checkouts, asking again whenever the thread's status or
 * its checkouts change.
 */
export function FileRefsProvider({
  threadId,
  children,
}: {
  threadId: ThreadId;
  children: ReactNode;
}) {
  const api = useApi();
  const resolver = resolverFor(api);
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const rootsKey = thread === undefined ? "" : checkoutRoots(thread).join("\n");
  const scope = useMemo(
    () => ({ threadId, roots: rootsKey === "" ? [] : rootsKey.split("\n"), resolver }),
    [threadId, rootsKey, resolver],
  );
  useEffect(
    () => resolver.refresh(threadId),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `status` and `rootsKey` are signals to refresh, not inputs
    [resolver, threadId, status, rootsKey],
  );
  return <FileRefsContext value={scope}>{children}</FileRefsContext>;
}

const wantsEditor = (
  event: Pick<MouseEvent | KeyboardEvent, "metaKey" | "ctrlKey">,
  mac = isMac(),
) => (mac ? event.metaKey : event.ctrlKey);

const subscribeNowhere = () => () => {};

const LINK = "cursor-pointer rounded-sm underline-offset-2 hover:underline";

const KIND_CLASS: Record<string, string> = {
  code: "decoration-muted-foreground",
  text: "font-mono text-code decoration-muted-foreground",
  link: "wrap-anywhere font-medium text-link underline",
};

const CANDIDATE_CLASS: Record<string, string> = {
  code: "",
  text: "font-mono text-code",
  link: "",
};

const notify = (kind: "info" | "error", title: string, body?: string) =>
  useThreadsStore
    .getState()
    .applyEvent({ type: "notify", kind, title, ...(body === undefined ? {} : { body }) });

function MenuAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function FileLink({
  scope,
  resolved,
  kind,
  line,
  end,
  column,
  focusOnMount = false,
  children,
}: {
  scope: FileRefsScope;
  resolved: string;
  kind: string;
  line: number | undefined;
  end: number | undefined;
  column: number | undefined;
  focusOnMount?: boolean | undefined;
  children?: ReactNode;
}) {
  const openInEditor = useOpenInEditor();
  const revealInFileManager = useRevealInFileManager();
  const local = useOpensLocally();
  const reveals = useFeature("revealInFileManager");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focusOnMount) anchor.current?.focus();
  }, [focusOnMount]);
  const secret = isCredentialPath(resolved);
  const scoped = mayBeInRoots(resolved, scope.roots);
  const position = positionLabel({ line, endLine: end, column });
  const target = position === "" ? resolved : `${resolved}:${position}`;

  const preview = () => showFileAt(scope.threadId, scope.roots, resolved, { line, end });
  const editor = () =>
    void openInEditor(resolved, {
      ...(scoped ? { threadId: scope.threadId } : {}),
      ...(line === undefined ? {} : { line }),
    });
  const reveal = () =>
    void revealInFileManager(resolved, scoped ? { threadId: scope.threadId } : {});
  const copy = () =>
    void copyText(resolved).then(
      () => notify("info", "Copied the path"),
      (error: unknown) => notify("error", "Couldn't copy", errorMessage(error)),
    );
  const activate = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    setOpen(secret);
    if (secret) return;
    if (local && wantsEditor(event)) editor();
    else preview();
  };
  const act = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === "trigger-press") return;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={500}
        nativeButton={false}
        render={
          <a
            ref={anchor}
            role="link"
            tabIndex={0}
            data-testid="file-ref"
            data-resolved={resolved}
            data-secret={secret || undefined}
            className={cn(LINK, KIND_CLASS[kind])}
            onClick={activate}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") activate(event);
            }}
          />
        }
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            data-testid="file-ref-menu"
            aria-label="File"
            className="flex max-w-md origin-(--transform-origin) items-center gap-1 rounded-md border border-edge bg-popover py-0.5 ps-2 pe-0.5 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <span
              className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
              title={target}
            >
              {target}
            </span>
            {!secret && (
              <MenuAction label="Open preview" onClick={act(preview)}>
                <Eye />
              </MenuAction>
            )}
            {!secret && local && (
              <MenuAction label="Open in editor" onClick={act(editor)}>
                <SquareArrowUpRightExit />
              </MenuAction>
            )}
            {reveals && (
              <MenuAction label={revealLabel()} onClick={act(reveal)}>
                <FolderOpen />
              </MenuAction>
            )}
            <MenuAction label="Copy path" onClick={act(copy)}>
              <Copy />
            </MenuAction>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FileRefLink({
  "data-path": path = "",
  "data-kind": kind = "text",
  "data-line": lineText,
  "data-end": endText,
  "data-column": columnText,
  children,
}: {
  "data-path"?: string;
  "data-kind"?: string;
  "data-line"?: string;
  "data-end"?: string;
  "data-column"?: string;
  children?: ReactNode;
}) {
  const scope = use(FileRefsContext);
  const inRoots = scope !== undefined && path !== "" && mayBeInRoots(path, scope.roots);
  const [pointed, setPointed] = useState(false);
  const pending = useRef<"editor" | "preview" | undefined>(undefined);
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const [focused, setFocused] = useState(false);
  const resolver = scope?.resolver;
  const threadId = scope?.threadId;
  const entry = useSyncExternalStore(resolver?.subscribe ?? subscribeNowhere, () =>
    path !== "" && threadId !== undefined ? resolver?.get(threadId, path) : null,
  );
  const wanted = inRoots || pointed;
  useEffect(() => {
    if (wanted && entry === undefined && threadId !== undefined) resolver?.request(threadId, path);
  }, [wanted, entry, resolver, threadId, path]);
  const line = lineText === undefined ? undefined : Number(lineText);
  const end = endText === undefined ? undefined : Number(endText);
  const column = columnText === undefined ? undefined : Number(columnText);
  useEffect(() => {
    const wants = pending.current;
    if (wants === undefined || entry === undefined || scope === undefined) return;
    pending.current = undefined;
    if (entry === null || isCredentialPath(entry.resolved)) return;
    if (wants === "editor") {
      void openInEditor(entry.resolved, {
        ...(mayBeInRoots(entry.resolved, scope.roots) ? { threadId: scope.threadId } : {}),
        ...(line === undefined ? {} : { line }),
      });
    } else {
      showFileAt(scope.threadId, scope.roots, entry.resolved, { line, end });
    }
  }, [entry, scope, line, end, openInEditor]);
  const ask = (event: MouseEvent | KeyboardEvent) => {
    pending.current = local && wantsEditor(event) ? "editor" : "preview";
    setPointed(true);
  };

  if (scope === undefined || entry === null) return <>{children}</>;
  if (entry === undefined) {
    if (inRoots) return <>{children}</>;
    return (
      <span
        role="link"
        tabIndex={0}
        data-testid="file-ref-candidate"
        className={CANDIDATE_CLASS[kind]}
        onPointerEnter={() => setPointed(true)}
        onFocus={() => {
          setFocused(true);
          setPointed(true);
        }}
        onBlur={() => setFocused(false)}
        onClick={ask}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          ask(event);
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <FileLink
      scope={scope}
      resolved={entry.resolved}
      kind={kind}
      line={line}
      end={end}
      column={column}
      focusOnMount={focused}
    >
      {children}
    </FileLink>
  );
}

export const FILE_REF_COMPONENTS = { [FILE_REF_TAG]: FileRefLink };
