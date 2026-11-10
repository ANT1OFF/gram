# One-off chat on any machine

- **Problem**: "Starting a one-off task seems a bit confusing. If I want to start one in the home
  directory of the CachyOS machine, it isn't easy." Today the Machine chip shows only for a git
  repository, and picking a joined machine forces a new worktree of its own clone. A plain folder
  on a joined machine (its home, say) can't be picked at all.
- **Who and where**: the user on New → Chat (`/new`, ⌘T), with one or more joined machines.
- **Must show**:
  - which machine and which folder the chat runs in, before Start;
  - this Mac and each joined machine with its state (online, offline, not signed in);
  - a folder on a joined machine, home (`~`) by default, typed or browsed there;
  - a folder Gram refuses (`~/.ssh`) and why;
  - that a folder outside a repository has no worktree, diff or PR.
- **Out of scope**: Task and Team (a worker's machine stays the existing picker); the thread
  header's chip is drawn in the build, not here.
- **Open questions** (defaults picked):
  - Home is the default folder on a joined machine. Default: yes.
  - Recent folders per machine come from that machine's past chats. Default: yes.
  - A git repository on a joined machine runs in the folder as it is (no new worktree). Default:
    yes; a new worktree there stays the existing way, from a repository on this Mac.
