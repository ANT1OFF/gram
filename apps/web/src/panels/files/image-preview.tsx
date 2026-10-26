import type { FileImage, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";

import { formatSize } from "./format";
import { filesProblem } from "./files-problem";

/**
 * The `fs.image` query for an image in the checkout; shared by the preview, markdown images and the
 * workspace Files view, which asks only once a thumbnail is near the screen (`enabled`).
 */
export function useCheckoutImage(threadId: ThreadId, path: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["fs.image", threadId, path],
    queryFn: () => api.fsImage(path, { threadId }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * The `attachment.read` query for a file attached to a message. Disabled for an extension the
 * server can't preview, so a `.heic` or `.bmp` attachment never asks.
 */
export function useAttachmentImage(threadId: ThreadId, path: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["attachment.read", threadId, path],
    queryFn: () => api.readAttachment(threadId, path),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** A `data:` URL for an image the server sent as base64; `undefined` when there are no bytes. */
export const imageDataUrl = (image: FileImage | undefined): string | undefined =>
  image === undefined || image.tooLarge || image.base64 === undefined
    ? undefined
    : `data:${image.mediaType};base64,${image.base64}`;

/**
 * An image from the checkout as a data URL. SVG is shown through `<img>` too, which renders it as a
 * static document: its scripts never run and it can't reach the page.
 */
export function CheckoutImage({
  threadId,
  path,
  alt,
  className,
}: {
  threadId: ThreadId;
  path: string;
  alt: string;
  className?: string;
}) {
  const query = useCheckoutImage(threadId, path);
  if (query.status === "pending") return <Shimmer>{alt || "Loading image…"}</Shimmer>;
  if (query.status === "error") {
    return <span className="text-xs text-danger-text">{filesProblem(query.error)}</span>;
  }
  if (query.data.tooLarge || query.data.base64 === undefined) {
    return (
      <span className="text-xs text-muted-foreground">
        {alt || "Image"} is too large to preview · {formatSize(query.data.size)}
      </span>
    );
  }
  return (
    <img
      data-testid="checkout-image"
      src={`data:${query.data.mediaType};base64,${query.data.base64}`}
      alt={alt}
      className={cn("max-w-full", className)}
    />
  );
}

/** The Files panel body for an image file. */
export function ImagePreview({ threadId, path }: { threadId: ThreadId; path: string }) {
  const query = useCheckoutImage(threadId, path);
  if (query.status === "pending") {
    return (
      <PanelMessage>
        <Shimmer>Loading image…</Shimmer>
      </PanelMessage>
    );
  }
  if (query.status === "error") return <PanelMessage>{filesProblem(query.error)}</PanelMessage>;
  if (query.data.tooLarge) {
    return <PanelMessage>Too large to preview · {formatSize(query.data.size)}</PanelMessage>;
  }
  return (
    <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
      <CheckoutImage
        threadId={threadId}
        path={path}
        alt={path.slice(path.lastIndexOf("/") + 1)}
        className="max-h-full object-contain"
      />
    </div>
  );
}
