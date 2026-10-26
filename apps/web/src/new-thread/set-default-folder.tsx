import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useServerSettings } from "@/settings-sync/store";

import { tildify } from "./path";

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

/**
 * "Set as default folder" for the chosen folder, saved as `~/…` when it's inside home. Shows a quiet
 * note instead when it already is the default.
 */
export function SetDefaultFolder({ path, home }: { path: string; home: string | undefined }) {
  const api = useApi();
  const current = useServerSettings((s) => s.settings?.agents.defaultFolder);
  const value = tildify(path, home);
  const save = useMutation({
    mutationFn: () => api.updateSettings({ agents: { defaultFolder: value } }),
    onSuccess: (settings) => useServerSettings.setState({ settings }),
  });

  if (current !== undefined && [value, path].includes(trimSlash(current))) {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Check aria-hidden className="size-3" />
        Default folder
      </span>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="ml-auto h-5 shrink-0 px-1.5 text-xs"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        Set as default folder
      </Button>
      {save.isError && (
        <span role="alert" className="shrink-0 text-danger-text">
          {errorMessage(save.error)}
        </span>
      )}
    </>
  );
}
