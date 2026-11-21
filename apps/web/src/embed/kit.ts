// Gram's own controls, for the pages an app in front of Gram adds beside Gram's: the second entry
// of the embeddable package (`@gram/web/kit`). They are the app's components themselves, from the
// same build as the app, so a tooltip here is under the app's tooltip provider and a button here
// is the button Gram draws. Each one added is a promise to keep its props: add what an embedding
// app's pages have needed, not everything there is. See docs/EMBEDDED_WEB_APP.md.
import type { ReactElement } from "react";

import { AgentIcon as AppAgentIcon } from "@/agents/agent-display";

export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorMarker,
} from "@/components/code/code-editor";
export { Diff } from "@/components/code/diff";
export { lineDiff, type DiffLine, type DiffSpan } from "@/components/code/text-diff";
export {
  AvatarRow,
  type AvatarRowProps,
  type AvatarRowTag,
  type AvatarRowTagLook,
  type AvatarRowTone,
} from "@/components/avatar-row";
export { EmptyState, type EmptyAction, type EmptyIcon } from "@/components/empty-state";
export { Hint } from "@/components/hint";
export {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
  type DataTableSort,
} from "@/components/data-table";
export { TreeChart, type TreeChartProps } from "@/components/tree-chart";
export { TreeList, type TreeListProps, type TreeNode } from "@/components/tree-list";
export { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
export {
  Avatar,
  type AvatarGlyph,
  type AvatarMarkProps,
  type AvatarProps,
  type AvatarSize,
  type AvatarStatus,
  type AvatarStatusProps,
} from "@/components/ui/avatar";
export { Badge } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { ButtonGroup } from "@/components/ui/button-group";
export { Checkbox, RadioGroup, type RadioOption } from "@/components/ui/checkbox";
export { ColorField, parseHex } from "@/components/ui/color-field";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
export { Input, InputGroup, Textarea } from "@/components/ui/input";
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
export { Meter, meterTone, type MeterTone } from "@/components/ui/meter";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export { Skeleton } from "@/components/ui/skeleton";
export { Switch } from "@/components/ui/switch";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
export { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
// Words for what is still loading ("Loading members…"), a band of light across them.
export { Shimmer } from "@/motion/shimmer";
// A page of settings, as Settings' own are built: the column, its groups, and a row per setting.
export { Field, OptionGroup, SettingRow, Toggle, type OptionGroupOption } from "@/settings/fields";
export { SettingsGroup } from "@/settings/settings-group";
// A popover hung from a button, as the title bar's own are: for a switcher or a short menu.
export { TitlebarPopover as Popover } from "@/shell/titlebar-popover";
// A centred dialog, mounted while it is open, and a sheet from the window's end edge.
export { DialogShell as Dialog, Sheet } from "@/thread/dialog-shell";

export { Page } from "./page";

/**
 * An agent's mark ("claude", "codex") in its provider's brand colour, for a page that lists model
 * accounts or agents. `labelled` where it stands alone, so it is the name to a screen reader.
 */
export const AgentIcon: (props: {
  agent: string;
  className?: string;
  labelled?: boolean;
}) => ReactElement = AppAgentIcon;

export { cn, type ClassInput } from "./kit-cn";
