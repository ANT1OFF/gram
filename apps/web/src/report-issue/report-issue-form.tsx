import {
  GRAM_REPO,
  type IssueArea,
  type IssueDraft,
  type IssueKind,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Bug,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { DialogShell } from "@/thread/dialog-shell";

const KINDS: readonly {
  readonly value: IssueKind;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The icon's colour while the kind is picked: the text colour, never a status one. */
  readonly tone: string;
}[] = [
  { value: "bug", label: "Bug", icon: Bug, tone: "text-foreground" },
  { value: "feature", label: "Feature", icon: Lightbulb, tone: "text-foreground" },
  { value: "question", label: "Question", icon: CircleHelp, tone: "text-foreground" },
];

const NO_AREA = "none";
const AREAS: readonly { readonly value: IssueArea | typeof NO_AREA; readonly label: string }[] = [
  { value: NO_AREA, label: "Any area" },
  { value: "web", label: "Interface" },
  { value: "desktop", label: "Desktop app" },
  { value: "server", label: "Server" },
  { value: "agents", label: "Agents" },
];

const labelCls = "text-meta font-medium text-muted-foreground";
const inputCls =
  "w-full rounded-lg border border-input bg-transparent px-2.5 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The form itself, loaded apart from the shell: `ReportIssueDialog` mounts it. */
export function ReportIssueForm({
  threadId,
  onClose,
}: {
  threadId: ThreadId | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const [kind, setKind] = useState<IssueKind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [area, setArea] = useState<IssueArea | typeof NO_AREA>(NO_AREA);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [filed, setFiled] = useState<{ number: number; url: string }>();

  const draft: IssueDraft = {
    kind,
    title: title.trim(),
    body,
    ...(area === NO_AREA ? {} : { area }),
    includeDiagnostics,
    ...(threadId === undefined ? {} : { threadId }),
  };
  // The footer doesn't depend on what's typed, so one preview serves the whole form.
  const footer = useQuery({
    queryKey: ["issues.footer", threadId],
    queryFn: () =>
      api.previewIssue({
        kind: "bug",
        title: "-",
        body: "",
        includeDiagnostics: true,
        ...(threadId === undefined ? {} : { threadId }),
      }),
    select: (issue) => issue.diagnostics,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || draft.title === "") return;
    setPending(true);
    setError(undefined);
    try {
      setFiled(await api.fileIssue(draft));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const openOnGitHub = async () => {
    try {
      const issue = await api.previewIssue(draft);
      await openExternalUrl(api, issue.newIssueUrl);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (filed !== undefined) {
    return (
      <DialogShell testId="report-issue-dialog" title="Report an issue" onClose={onClose}>
        <div data-testid="report-issue-filed" className="flex items-center gap-2 text-reading">
          <CircleCheck aria-hidden className="size-icon-row shrink-0 text-success" />
          <button
            type="button"
            className="font-medium text-link underline-offset-2 hover:underline"
            onClick={() => void openExternalUrl(api, filed.url)}
          >
            #{filed.number}
          </button>
          <span className="min-w-0 truncate text-muted-foreground">{draft.title}</span>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      testId="report-issue-dialog"
      title="Report an issue"
      description={`Filed on ${GRAM_REPO} with your GitHub account.`}
      onClose={onClose}
    >
      <form className="flex min-h-0 flex-col gap-3" onSubmit={(event) => void submit(event)}>
        {/* The fields scroll in a short window; the error and the buttons below them stay in view.
            The inset keeps the inputs' focus rings inside the scroll box. */}
        <div
          data-testid="report-issue-fields"
          className="-m-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-1"
        >
          <div
            role="radiogroup"
            aria-label="Kind"
            className="flex gap-1"
            onKeyDown={(event) =>
              radioGroupKeyDown(
                event,
                KINDS.map((option) => option.value),
                kind,
                setKind,
              )
            }
          >
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                tabIndex={kind === option.value ? 0 : -1}
                onClick={() => setKind(option.value)}
                className="group flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-reading text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:border-ring aria-checked:bg-accent aria-checked:text-foreground"
              >
                <option.icon
                  aria-hidden
                  className={cn("size-icon-row", kind === option.value && option.tone)}
                />
                {option.label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Title</span>
            <input
              aria-label="Title"
              className={cn(inputCls, "h-8")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Description</span>
            <textarea
              aria-label="Description"
              rows={6}
              placeholder={
                kind === "bug"
                  ? "What you did, what happened, what you expected"
                  : kind === "feature"
                    ? "The problem it would solve"
                    : undefined
              }
              className={cn(inputCls, "resize-y py-2")}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={area}
              items={AREAS}
              onValueChange={(next) => {
                if (next !== null) setArea(next);
              }}
            >
              <SelectTrigger aria-label="Area" className="text-meta">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AREAS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex h-8 items-center gap-2 text-reading">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
              />
              Include diagnostics
            </label>
          </div>
          {includeDiagnostics && footer.data !== undefined && (
            <Collapsible>
              <CollapsibleTrigger
                data-testid="report-issue-diagnostics"
                className="group flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  aria-hidden
                  className="size-icon-chip shrink-0 transition-transform group-data-[panel-open]:rotate-90"
                />
                What's added
              </CollapsibleTrigger>
              <CollapsibleContent className="gram-collapse">
                <pre
                  data-testid="report-issue-diagnostics-body"
                  className="mt-1 overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-meta whitespace-pre-wrap"
                >
                  {footer.data}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
        {error !== undefined && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-meta text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="report-issue-open-github"
              onClick={() => void openOnGitHub()}
            >
              Open on GitHub
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || draft.title === ""}>
            {pending ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
