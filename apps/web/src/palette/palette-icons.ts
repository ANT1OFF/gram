import {
  Brain,
  ChartNoAxesCombined,
  Columns3,
  FileText,
  Folder,
  GitPullRequest,
  History,
  Inbox,
  Layers,
  MessageSquare,
  Moon,
  Network,
  Settings2,
  SquareChevronRight,
  TextSearch,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/** What a palette row is, which its glyph says: the same glyph each kind has elsewhere in Gram. */
export type PaletteIcon =
  | "thread"
  | "orchestrator"
  | "worker"
  | "feature"
  | "pr"
  | "project"
  | "message"
  | "doc"
  | "command"
  | "setting"
  | "inbox"
  | "history"
  | "board"
  | "memory"
  | "quiet"
  | "usage";

const ICONS: Readonly<Record<PaletteIcon, LucideIcon>> = {
  thread: MessageSquare,
  orchestrator: Network,
  worker: Workflow,
  feature: Layers,
  pr: GitPullRequest,
  project: Folder,
  message: TextSearch,
  doc: FileText,
  command: SquareChevronRight,
  setting: Settings2,
  inbox: Inbox,
  history: History,
  board: Columns3,
  memory: Brain,
  quiet: Moon,
  usage: ChartNoAxesCombined,
};

/** Each destination's glyph, by its id. */
const DESTINATIONS: Readonly<Record<string, PaletteIcon>> = {
  "go:workers": "worker",
  "go:memory": "memory",
  "go:quiet": "quiet",
  "go:inbox": "inbox",
  "go:history": "history",
  "go:board": "board",
  "go:usage": "usage",
  "go:settings": "setting",
};

/** The kind a row's id names, for rows that don't say their own. */
const BY_PREFIX: readonly (readonly [string, PaletteIcon])[] = [
  ["thread:", "thread"],
  ["worker:", "worker"],
  ["feature:", "feature"],
  ["pr:", "pr"],
  ["project:", "project"],
  ["message:", "message"],
  ["doc:", "doc"],
  ["resume:", "thread"],
];

/**
 * A row's kind: its own when it says one, a destination's, the kind its id names, else a command
 * when it is one. Show more rows, picker choices and the like have none.
 */
export function paletteIconKind(item: {
  id: string;
  icon?: PaletteIcon | undefined;
}): PaletteIcon | undefined {
  if (item.icon !== undefined) return item.icon;
  const destination = DESTINATIONS[item.id];
  if (destination !== undefined) return destination;
  const prefixed = BY_PREFIX.find(([prefix]) => item.id.startsWith(prefix));
  if (prefixed !== undefined) return prefixed[1];
  if (item.id.startsWith("action:")) return /settings/i.test(item.id) ? "setting" : "command";
  return undefined;
}

export const paletteIcon = (kind: PaletteIcon): LucideIcon => ICONS[kind];
