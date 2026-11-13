# Machine marker

- **Problem**: "I want to show where a worker runs when it is on a different machine, in the
  sidebar and other places in the Gram app." Today a worker on a joined machine reads like any
  other in the sidebar: only its thread header names the machine, and the Workers tab draws a
  12 px glyph with the name on hover. A machine that went offline shows nowhere but Settings →
  Machines and the New thread picker.
- **Who and where**: the user with one or more joined machines or provisioned hosts, looking at
  the sidebar's worker and solo rows, a thread's header, the Workers tab, the Board, a feature
  card in the orchestrator's chat, and the Inbox.
- **Must show**:
  - nothing for a thread on this machine;
  - a thread on a joined machine that is online (`atlas`, "online for 2 hours");
  - one on a provisioned host (`sandbox-1`);
  - one whose machine is offline (`studio`, "Connection lost at 14:03."), and that the state is
    visible without hovering;
  - the marker beside a row's own trailing words ("checks", "asks you") and beside nothing, at
    work;
  - the hover: the machine, its kind (joined machine or provisioned host), its state, and why and
    the fix when it is offline, in the words Settings → Machines uses (`machineHealth`).
- **Out of scope**: the New thread machine picker and Settings → Machines, which stay as they
  are; moving a thread between machines; the compact rail's tiles; the phone layout. The text an
  orchestrator reads (`list_workers`, the ledger) gains the machine's name and state in the build
  and has no look to pick.
- **Open questions** (defaults picked):
  - One glyph for every other machine, Lucide `Server`, as the header chip and the picker already
    use; a provisioned host differs only on hover. Default: yes.
  - Offline swaps the glyph for `ServerOff` and adds the word "offline", in the neutral text
    colour: the glyph's shape says it, and a turn that failed because of it already has its red
    dot. The page's tweak shows it in the danger colour instead. Default: neutral.
  - "Needs update" (a host this Gram can't talk to) is drawn as offline is, with those words.
    Default: yes.
  - The machine's name and state reach every client from the server, a paired phone included,
    rather than from the local-only Settings listing. Default: yes, decided in the build.
