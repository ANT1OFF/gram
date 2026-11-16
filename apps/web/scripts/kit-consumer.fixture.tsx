// An embedding app's page, type-checked against the package's own declarations (not these
// sources) by embed-types.test.mjs: each kit export an app names, with the props it passes. A prop
// marked `@ts-expect-error` proves the export is typed, not `any`. Never bundled or run.
import {
  AgentIcon,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ButtonGroup,
  buttonVariants,
  Checkbox,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  EmptyState,
  Field,
  Hint,
  Input,
  InputGroup,
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
  Meter,
  meterTone,
  OptionGroup,
  Page,
  Popover,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SettingRow,
  SettingsGroup,
  Sheet,
  Shimmer,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type ClassInput,
  type EmptyAction,
  type EmptyIcon,
  type MeterTone,
  type OptionGroupOption,
  type RadioOption,
} from "@gram/web/kit";

type Level = "low" | "high";

const levels: readonly OptionGroupOption<Level>[] = [
  { value: "low", label: "Low", description: "Reads only." },
  { value: "high", label: "High", description: "Reads and writes.", testId: "level-high" },
];
const modes: readonly RadioOption<Level>[] = [
  { value: "low", label: "Low" },
  { value: "high", label: "High", description: "Asks first.", disabled: true },
];
// @ts-expect-error: an option's value outside its type
export const wrong: readonly OptionGroupOption<Level>[] = [{ value: "mid", label: "Mid" }];
const Glyph: EmptyIcon = ({ className }) => <svg className={className} />;
const add: EmptyAction = { label: "Add a member", onClick: () => {}, testId: "add" };
const tone: MeterTone = meterTone(0.95);
const classes: ClassInput = ["p-inset", false, null];

export function KitPage({ pick }: { pick: (level: Level) => void }) {
  return (
    <Page title="Limits" description="What it may spend." actions={<Button size="sm">Add</Button>}>
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </Tabs>
      <SettingsGroup label="Spend" description="A cap.">
        <SettingRow label="Cap" error="A whole number">
          <InputGroup prefix="$">
            <Input invalid className={cn(classes, "w-24")} />
          </InputGroup>
        </SettingRow>
        <Toggle label="On" checked onChange={() => {}} />
        <Field label="Brief" htmlFor="brief">
          <Textarea id="brief" rows={3} invalid={false} />
        </Field>
        <OptionGroup<Level> label="Level" options={levels} value="low" onChange={pick} />
        <RadioGroup<Level> label="Mode" options={modes} value={undefined} onChange={pick} />
        <Checkbox label="Also delete" description="The folder goes too." defaultChecked />
        <Checkbox aria-label="Bare" />
      </SettingsGroup>
      <ButtonGroup>
        <Button render={<a href="/x" />} nativeButton={false} variant="outline">
          Link
        </Button>
      </ButtonGroup>
      <a href="/y" className={buttonVariants({ variant: "outline", size: "sm" })}>
        Outline link
      </a>
      <Badge render={<a href="/z" />} variant="secondary">
        2
      </Badge>
      <EmptyState icon={Glyph} title="No members yet" line="Invite one to start." action={add} />
      <Skeleton className="h-7 w-40" />
      <Shimmer>Loading members…</Shimmer>
      <Badge variant="success">Passing</Badge>
      <Badge variant="warning">Bypass</Badge>
      <Alert variant="warning">
        <AlertTitle>Writes go live</AlertTitle>
      </Alert>
      <Alert variant="success">Saved</Alert>
      <SettingsGroup label="Members" plainOnPhone card>
        Rows
      </SettingsGroup>
      <Page
        title="Ada Lovelace"
        above={<a href="/members">Members</a>}
        headingLevel={2}
        hideTitleOnPhone
        wide
      >
        <SettingsGroup label="Keys">
          <SettingRow
            label={
              <>
                Deploy key <code>ed25519</code>
              </>
            }
            labelText="Deploy key"
            description={<a href="/docs">How keys work</a>}
          />
          <Toggle
            label={<i>Digest</i>}
            labelText="Digest"
            testId="digest"
            checked={false}
            onChange={() => {}}
          />
          <Field label={<b>Name</b>} labelText="Name" testId="name">
            <Input />
          </Field>
        </SettingsGroup>
      </Page>
      <Alert variant="destructive">
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>Try again.</AlertDescription>
      </Alert>
      <Tooltip>
        <TooltipTrigger render={<Button size="icon" aria-label="Help" />} />
        <TooltipContent>Help</TooltipContent>
      </Tooltip>
      <Hint label="More" render={<Button variant="ghost" />}>
        x
      </Hint>
      <Collapsible>
        <CollapsibleTrigger>More</CollapsibleTrigger>
        <CollapsibleContent>Rest</CollapsibleContent>
      </Collapsible>
      <Select defaultValue="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectSeparator />
        </SelectContent>
      </Select>
      <Switch checked onCheckedChange={() => {}} />
      <Meter value={0.5} tone={tone} label="Used" />
      <Popover label="Orgs" trigger={<Button>Acme</Button>}>
        Acme
      </Popover>
      <AgentIcon agent="claude" labelled />
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Actions" />} />
        <MenuContent align="start" data-testid="menu">
          <MenuGroup>
            <MenuLabel>Member</MenuLabel>
            <MenuItem onClick={() => {}}>Rename</MenuItem>
            <MenuItem danger disabled>
              Remove
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuCheckboxItem checked onCheckedChange={() => {}}>
            Pinned
          </MenuCheckboxItem>
          <MenuRadioGroup value="a" onValueChange={() => {}}>
            <MenuRadioItem value="a">A</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSub>
            <MenuSubTrigger>More</MenuSubTrigger>
            <MenuSubContent>
              <MenuItem>Deep</MenuItem>
            </MenuSubContent>
          </MenuSub>
        </MenuContent>
      </Menu>
      <Dialog title="Remove member?" description="They lose access." onClose={() => {}}>
        <Button variant="destructive">Remove</Button>
      </Dialog>
      <Sheet open title="Member" onClose={() => {}} wide actions={<Button size="sm">Edit</Button>}>
        Body
      </Sheet>
      {/* @ts-expect-error: a sheet is open or not */}
      <Sheet title="Member" onClose={() => {}}>
        Body
      </Sheet>
      {/* @ts-expect-error: a variant the kit doesn't have */}
      <Button variant="huge">No</Button>
      {/* @ts-expect-error: a page's title is words, for its heading and its key */}
      <Page title={<b>Rich</b>}>No</Page>
      {/* @ts-expect-error: a page needs its title */}
      <Page>No title</Page>
    </Page>
  );
}
