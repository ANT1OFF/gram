/** What a session is told about its shared folder, beside the folder itself. */
export const sharedFolderNote = (path: string): string =>
  [
    `Shared folder: ${path}`,
    "Every thread in this workspace can read and write this folder, on this machine and on others, and it is kept when threads end and machines stop. Put files there that other threads need or that should outlive this thread: notes, data, reports, images. A change reaches other machines within seconds; when two threads change the same file at once, the later write wins. Don't put credentials there.",
  ].join("\n");
