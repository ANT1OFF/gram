import { describe, expect, it } from "vitest";

import * as kit from "./kit";

// What `@gram/web/kit` exports: an app in front of Gram builds its pages on these, so one taken
// away or renamed breaks that app's next move to a newer Gram (docs/EMBEDDED_WEB_APP.md, "Keeping
// embedders in step"). Add a name here with the export; remove one only with an "Embedders" line.
const EXPORTS = [
  "AgentIcon",
  "Alert",
  "AlertDescription",
  "AlertTitle",
  "Avatar",
  "AvatarRow",
  "Badge",
  "Button",
  "ButtonGroup",
  "Checkbox",
  "CodeEditor",
  "ColorField",
  "Diff",
  "Collapsible",
  "Dialog",
  "CollapsibleContent",
  "CollapsibleTrigger",
  "EmptyState",
  "Field",
  "Hint",
  "Input",
  "InputGroup",
  "Menu",
  "MenuCheckboxItem",
  "MenuContent",
  "MenuGroup",
  "MenuItem",
  "MenuLabel",
  "MenuRadioGroup",
  "MenuRadioItem",
  "MenuSeparator",
  "MenuSub",
  "MenuSubContent",
  "MenuSubTrigger",
  "MenuTrigger",
  "Meter",
  "OptionGroup",
  "Page",
  "Popover",
  "RadioGroup",
  "Select",
  "SelectContent",
  "SelectItem",
  "SelectSeparator",
  "SelectTrigger",
  "SelectValue",
  "SettingRow",
  "SettingsGroup",
  "Sheet",
  "Shimmer",
  "Skeleton",
  "Switch",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "Textarea",
  "Toggle",
  "Tooltip",
  "TooltipContent",
  "TooltipTrigger",
  "TreeList",
  "buttonVariants",
  "cn",
  "lineDiff",
  "meterTone",
  "parseHex",
];

describe("@gram/web/kit", () => {
  it("exports exactly the controls embedders build on", () => {
    expect(Object.keys(kit).toSorted()).toEqual(EXPORTS.toSorted());
  });

  it("joins classes as Gram's components do", () => {
    expect(kit.cn("p-2", false, ["p-4", null], undefined)).toBe("p-4");
  });
});
