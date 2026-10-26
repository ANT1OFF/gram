/**
 * What an agent is told when the user pauses its workspace: as the refusal of every tool call its
 * closed tool gate meets (`AgentSession.closeToolGate`), or, with no gate, steered into its turn.
 * Nothing interrupts it: the turn ends when the agent ends it.
 */
export const PAUSE_STOP_TEXT =
  "The user paused this workspace. Don't start any more tool calls: let one that is running finish, then end your turn now. You'll be told when to continue.";
