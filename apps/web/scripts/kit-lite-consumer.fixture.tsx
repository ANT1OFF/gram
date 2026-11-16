// A page an app shows before Gram mounts, type-checked against the package's own declarations of
// the light kit by embed-types.test.mjs. A prop marked `@ts-expect-error` proves the export is
// typed, not `any`. Never bundled or run.
import {
  Alert,
  AlertDescription,
  AlertTitle,
  applyGramTheme,
  Badge,
  Button,
  ButtonGroup,
  buttonVariants,
  Checkbox,
  cn,
  Field,
  Input,
  InputGroup,
  RadioGroup,
  Shimmer,
  Skeleton,
  Textarea,
  type ClassInput,
  type FieldProps,
  type HostTheme,
  type RadioOption,
} from "@gram/web/kit-lite";

const theme: HostTheme = { name: "House", fonts: { ui: "Inter" } };
applyGramTheme(theme);
applyGramTheme();
const classes: ClassInput = ["p-inset", false];
const modes: readonly RadioOption<"a" | "b">[] = [{ value: "a", label: "A" }];
const email = { label: "Email", htmlFor: "email" } as const;
// @ts-expect-error: a name that isn't words brings its words
export const unnamed: FieldProps = { label: <b>Email</b>, children: null };

export function SignIn() {
  return (
    <main className={cn(classes, "p-section")}>
      <Alert variant="warning">
        <AlertTitle>Maintenance</AlertTitle>
        <AlertDescription>Tonight.</AlertDescription>
      </Alert>
      <Field {...email} description="The one you were invited with.">
        <Input id="email" invalid={false} />
      </Field>
      <Field label={<b>Note</b>} labelText="Note">
        <Textarea rows={2} />
      </Field>
      <InputGroup prefix="@">
        <Input />
      </InputGroup>
      <Checkbox label="Keep me signed in" onCheckedChange={() => {}} />
      <RadioGroup label="Mode" options={modes} value="a" onChange={() => {}} />
      <Badge variant="success">New</Badge>
      <Skeleton className="h-4" />
      <Shimmer>Signing in…</Shimmer>
      <ButtonGroup>
        <Button render={<a href="/help" />} nativeButton={false} variant="outline">
          Help
        </Button>
      </ButtonGroup>
      <a href="/x" className={buttonVariants({ variant: "link" })}>
        Forgot?
      </a>
      {/* @ts-expect-error: a variant the kit doesn't have */}
      <Button variant="huge">No</Button>
    </main>
  );
}
