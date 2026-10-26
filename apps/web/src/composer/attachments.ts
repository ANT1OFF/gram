import { MAX_ATTACHMENT_BYTES, type Attachment } from "@gram/contracts";

import type { Api, AttachmentTarget } from "@/api/types";

/** A composer chip: a file being uploaded, ready to send, or rejected. */
export interface PendingAttachment {
  readonly key: string;
  readonly name: string;
  readonly status: "uploading" | "ready" | "failed";
  readonly attachment?: Attachment;
  /** An object URL for an image thumbnail; revoked when the chip goes away. */
  readonly previewUrl?: string;
  readonly error?: string;
}

/** Base64 in 32 KB slices, so large files don't overflow `String.fromCharCode`'s arguments. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/**
 * The attachment for `file`: its real path when the desktop shell knows one (a file dragged from
 * disk), otherwise an upload that stores the bytes for the thread or the draft (a pasted screenshot).
 */
export const attachFile = async (
  api: Pick<Api, "uploadAttachment">,
  target: AttachmentTarget,
  file: File,
  pathOf: (file: File) => string | undefined = () => undefined,
): Promise<Attachment> => {
  const path = pathOf(file);
  if (path) return { path, name: file.name, ...(file.type ? { mediaType: file.type } : {}) };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.name} is over the ${MAX_ATTACHMENT_BYTES / 2 ** 20} MB attachment limit`,
    );
  }
  const data = toBase64(new Uint8Array(await file.arrayBuffer()));
  return api.uploadAttachment(target, { name: file.name, mediaType: file.type, data });
};
