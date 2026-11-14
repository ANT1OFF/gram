import { Menu } from "@base-ui/react/menu";
import { Check, MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useConversationOnly } from "@/stores/conversation-only";

/** The mode's name, wherever it is switched. */
export const CONVERSATION_ONLY = "Conversation only";

/** What the switch does, for its hint off and on. */
const HINT = {
  off: "Conversation only: hide tool calls and reasoning",
  on: "Showing the conversation only. Show tool calls and reasoning",
};

/**
 * The header's switch for "Conversation only": the bare glyph while off, and pressed with its name
 * while on, so a transcript without its tool calls says why. `hideClass` drops the name where the
 * header is short of room.
 */
export function ConversationOnlyButton({
  hideClass,
  inTitlebar = false,
}: {
  hideClass?: string;
  /** In the window's title bar, whose glyphs are a toolbar's 18 px rather than a row's 16. */
  inTitlebar?: boolean;
}) {
  const on = useConversationOnly((s) => s.on);
  const keys = useShortcutHint("view.conversationOnly");
  return (
    <Button
      variant="ghost"
      size={on ? "xs" : inTitlebar ? "icon-sm" : "icon-xs"}
      data-testid="conversation-only"
      aria-pressed={on}
      aria-label={CONVERSATION_ONLY}
      title={withHint(on ? HINT.on : HINT.off, keys)}
      className={cn(
        "shrink-0 text-muted-foreground",
        on && "bg-accent text-foreground @max-sm:size-7 @max-sm:px-0",
      )}
      onClick={() => useConversationOnly.getState().toggle()}
    >
      <MessageSquareText aria-hidden />
      {on && <span className={hideClass}>{CONVERSATION_ONLY}</span>}
    </Button>
  );
}

/** The same switch as a menu's checked item: the title bar's View and a pane's "…". */
export function ConversationOnlyItem({ className }: { className: string }) {
  const on = useConversationOnly((s) => s.on);
  const keys = useShortcutHint("view.conversationOnly");
  return (
    <Menu.CheckboxItem
      data-testid="menu-conversation-only"
      // One toggle, so the menu closes on it and the transcript shows the change at once.
      closeOnClick
      className={className}
      checked={on}
      onCheckedChange={(checked) => useConversationOnly.getState().set(checked)}
    >
      <span className="flex size-icon-row shrink-0 items-center justify-center">
        <Menu.CheckboxItemIndicator>
          <Check aria-hidden className="size-icon-row" />
        </Menu.CheckboxItemIndicator>
      </span>
      {CONVERSATION_ONLY}
      {keys && (
        <span className="ml-auto pl-4 text-meta text-muted-foreground phone:hidden">{keys}</span>
      )}
    </Menu.CheckboxItem>
  );
}
