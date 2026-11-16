// The light kit (`@gram/web/kit-lite`): Gram's basic controls and its look for the pages an app in
// front of Gram shows before Gram mounts (sign-in, a landing page, a boot screen), without the app
// itself. The same modules as the full kit (`./kit`), from the same sources, built on their own
// with a stylesheet of their own (`kit-lite.css`), so a page that never mounts Gram loads neither
// Gram's app nor its whole stylesheet. Kept small: its budget is in bundle-budgets.json
// (`kitLiteKb`). See docs/EMBEDDED_WEB_APP.md.
export { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
export { Badge } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { ButtonGroup } from "@/components/ui/button-group";
export { Checkbox, RadioGroup, type RadioOption } from "@/components/ui/checkbox";
export { Input, InputGroup, Textarea } from "@/components/ui/input";
export { Skeleton } from "@/components/ui/skeleton";
export { Shimmer } from "@/motion/shimmer";
// Settings' Field as it is drawn, without the search and "Saved" a page of settings adds.
export { Field, type FieldProps } from "@/settings/field-frame";

export { applyGramTheme } from "./apply-theme";
export type { HostTheme } from "./contract";
export { cn, type ClassInput } from "./kit-cn";
