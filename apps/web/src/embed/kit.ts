// Gram's own controls, for the pages an app in front of Gram adds beside Gram's: the second entry
// of the embeddable package (`@gram/web/kit`). They are the app's components themselves, from the
// same build as the app, so a tooltip here is under the app's tooltip provider and a button here
// is the button Gram draws. Each one added is a promise to keep its props: add what an embedding
// app's pages have needed, not everything there is. See docs/EMBEDDED_WEB_APP.md.
import { cn as appCn } from "@/lib/utils";

export { Hint } from "@/components/hint";
export { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
export { Badge } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { ButtonGroup } from "@/components/ui/button-group";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
export { Input, InputGroup } from "@/components/ui/input";
export { Meter, meterTone, type MeterTone } from "@/components/ui/meter";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export { Switch } from "@/components/ui/switch";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
export { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
// A page of settings, as Settings' own are built: the column, its groups, and a row per setting.
export { Field, OptionGroup, SettingRow, Toggle } from "@/settings/fields";
export { SettingsGroup } from "@/settings/settings-group";
// A popover hung from a button, as the title bar's own are: for a switcher or a short menu.
export { TitlebarPopover as Popover } from "@/shell/titlebar-popover";

export { Page } from "./page";

/** A class or a falsy value that is left out. */
export type ClassInput = string | false | null | undefined | readonly ClassInput[];

/**
 * Joins class names, leaving out the falsy ones, and settles Tailwind classes that conflict in
 * favour of the later one, as Gram's own components do.
 */
export const cn: (...classes: ClassInput[]) => string = (...classes) =>
  appCn(...(classes as Parameters<typeof appCn>));
