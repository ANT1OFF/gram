import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** "Choose folder…": the system folder dialog. Only in the desktop app, which has the bridge. */
export function ChooseFolderButton({
  onChoose,
  label = "Choose folder…",
  defaultPath,
  disabled,
}: {
  onChoose: (path: string) => void;
  /** What the button says, for when choosing a folder also adds it. */
  label?: string | undefined;
  /** An absolute folder the dialog starts in. */
  defaultPath?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const [choosing, setChoosing] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.gram;
  if (bridge?.chooseFolder === undefined) return null;

  const choose = async () => {
    setChoosing(true);
    try {
      const path = await bridge.chooseFolder?.(defaultPath === undefined ? {} : { defaultPath });
      if (path !== undefined) onChoose(path);
    } finally {
      setChoosing(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8"
      disabled={choosing || disabled === true}
      onClick={() => void choose()}
    >
      <FolderOpen data-icon="inline-start" />
      {label}
    </Button>
  );
}
