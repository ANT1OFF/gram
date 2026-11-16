// A page of the app's that shows before Gram mounts, a sign-in, drawn with the light kit alone:
// it loads `gram-web/kit-lite` and its stylesheet, and none of Gram's app.
import {
  Alert,
  AlertDescription,
  AlertTitle,
  applyGramTheme,
  Button,
  Checkbox,
  Field,
  Input,
} from "gram-web/kit-lite";
import "gram-web/kit-lite.css";
// The app's own Tailwind build, on the names of Gram's theme, for the page's own layout.
import "./style.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";

// The palette the app also mounts Gram with, so the page reads as the app Gram will be in.
const SEEDS = {
  muted: "#8a887f",
  accent: "#ecebe6",
  accent2: "#c2a878",
  red: "#d27a6e",
  green: "#8fb58a",
  yellow: "#c2a878",
  cyan: "#7fa6b5",
};
applyGramTheme({
  name: "House",
  palettes: {
    dark: { ...SEEDS, bg: "#0b0c0d", surface: "#0b0c0d", text: "#ecebe6" },
    light: { ...SEEDS, bg: "#fbfaf7", surface: "#fbfaf7", text: "#1c1b18", accent: "#1c1b18" },
  },
});

function SignIn() {
  const [email, setEmail] = useState("");
  const invalid = email !== "" && !email.includes("@");
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-section p-section">
      <h1 data-testid="lite-title" className="font-heading text-heading">
        Sign in
      </h1>
      <Alert variant="warning">
        <AlertTitle>Maintenance tonight</AlertTitle>
        <AlertDescription>Sign-in pauses from 22:00 to 22:30.</AlertDescription>
      </Alert>
      <Field label="Email" htmlFor="lite-email" description="The one you were invited with.">
        <Input
          id="lite-email"
          data-testid="lite-email"
          value={email}
          invalid={invalid}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Checkbox label="Keep me signed in" data-testid="lite-keep" />
      <Button data-testid="lite-submit">Continue</Button>
    </main>
  );
}

const element = document.getElementById("root");
if (element === null) throw new Error("#root element missing");
createRoot(element).render(<SignIn />);
