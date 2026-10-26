import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";

import { ExpandableError, inputCls, WhyDisabled } from "./fields";

/**
 * A custom `terminal.shell`: an executable name or full path, checked by the server the way a new
 * terminal resolves it before it's saved. `.cmd` and `.bat` shells run through cmd.exe.
 */
export function CustomShellField({
  value,
  onSave,
}: {
  /** The saved custom shell, when the setting isn't one of the profiles. */
  value: string | undefined;
  onSave: (shell: string) => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState(value ?? "");
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  const check = async () => {
    const shell = draft.trim();
    if (shell === "" || checking) return;
    setChecking(true);
    setStatus(undefined);
    try {
      const result = await api.terminalCheckShell(shell);
      if (result.found) {
        onSave(shell);
        setStatus({ ok: true, text: `Terminals start ${result.file ?? shell}.` });
      } else {
        setStatus({ ok: false, text: result.message ?? `${shell} wasn't found.` });
      }
    } catch (error) {
      setStatus({ ok: false, text: `Couldn't check the shell: ${errorMessage(error)}` });
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void check();
      }}
    >
      <div className="flex max-w-md items-center gap-2">
        <input
          aria-label="Custom shell path"
          className={inputCls}
          value={draft}
          placeholder="C:\Program Files\Git\bin\bash.exe"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setStatus(undefined);
          }}
        />
        <WhyDisabled
          reason={
            checking
              ? "Checking the shell…"
              : draft.trim() === ""
                ? "Type a shell's name or path first."
                : undefined
          }
        >
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={checking || draft.trim() === ""}
          >
            {checking ? "Checking…" : "Use this shell"}
          </Button>
        </WhyDisabled>
      </div>
      {status &&
        (status.ok ? (
          <p role="status" className="text-xs text-muted-foreground">
            {status.text}
          </p>
        ) : (
          <ExpandableError message={status.text} />
        ))}
    </form>
  );
}
