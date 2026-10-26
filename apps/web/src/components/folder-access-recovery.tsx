import type { FolderAccessDenial } from "@gram/contracts";
import { FolderLock, RotateCw } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { folderAccessDiagnostics, PRIVACY_SETTINGS_FALLBACK } from "@/api/folder-access";
import { Button } from "@/components/ui/button";
import { copyText } from "@/settings/copy-text";

/**
 * A folder or file the OS won't let Gram read: which path, the server's advice, and Retry,
 * the macOS Privacy Settings shortcut (desktop app only) and diagnostic details to copy.
 */
export function FolderAccessRecovery({
  denial,
  message,
  onRetry,
  retrying = false,
}: {
  denial: FolderAccessDenial;
  /** The server's message, already written for the user. */
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.gram;
  const privacy = bridge?.platform === "darwin" ? bridge.openPrivacySettings : undefined;
  const [hint, setHint] = useState<string>();
  const [status, setStatus] = useState<string>();

  const openPrivacy = async () => {
    const opened = await privacy?.().catch(() => false);
    setHint(opened ? undefined : PRIVACY_SETTINGS_FALLBACK);
  };

  const copy = async () => {
    try {
      const bundlePath = await bridge?.appBundlePath?.().catch(() => undefined);
      await copyText(
        folderAccessDiagnostics(denial, { platform: bridge?.platform ?? "browser", bundlePath }),
      );
      setStatus("Copied diagnostic details.");
    } catch (error) {
      setStatus(`Couldn't copy: ${errorMessage(error)}`);
    }
  };

  return (
    <div data-testid="folder-access-recovery" className="flex flex-col gap-2 p-3 text-xs">
      <p role="alert" className="flex items-center gap-1.5 font-medium text-danger-text">
        <FolderLock aria-hidden className="size-3.5 shrink-0" />
        Gram can&apos;t read this folder
      </p>
      <p className="font-mono break-all text-foreground">{denial.path}</p>
      <p className="text-muted-foreground">{message}</p>
      {hint && <p className="text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
          <RotateCw data-icon="inline-start" />
          Retry
        </Button>
        {privacy && (
          <Button type="button" size="xs" variant="outline" onClick={() => void openPrivacy()}>
            Open Privacy Settings
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={() => void copy()}>
          Copy diagnostic details
        </Button>
      </div>
      {status && (
        <p role="status" className="text-muted-foreground">
          {status}
        </p>
      )}
    </div>
  );
}
