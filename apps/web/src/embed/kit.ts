// Gram's own controls, for the pages an app in front of Gram adds beside Gram's: the second entry
// of the embeddable package (`@gram/web/kit`). They are the app's components themselves, from the
// same build as the app, so a tooltip here is under the app's tooltip provider and a button here
// is the button Gram draws. Each one added is a promise to keep its props: add what an embedding
// app's pages have needed, not everything there is. See docs/EMBEDDED_WEB_APP.md.
export { Hint } from "@/components/hint";
export { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
export { Badge } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { ButtonGroup } from "@/components/ui/button-group";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
export { cn } from "@/lib/utils";
